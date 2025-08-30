#!/bin/bash

# Deploy using AWS CodeBuild (no local Docker required)
# This builds the container image in AWS instead of locally

set -e

PROJECT_NAME="amplify-docs-mcp"
AWS_REGION=${AWS_REGION:-us-east-1}
STACK_NAME=${STACK_NAME:-$PROJECT_NAME}

log_info() {
    echo -e "\033[0;34m[INFO]\033[0m $1"
}

log_success() {
    echo -e "\033[0;32m[SUCCESS]\033[0m $1"
}

log_error() {
    echo -e "\033[0;31m[ERROR]\033[0m $1"
}

# Check AWS CLI
if ! command -v aws &> /dev/null; then
    log_error "AWS CLI not found. Please install AWS CLI."
    exit 1
fi

# Get AWS account ID
AWS_ACCOUNT_ID=$(aws sts get-caller-identity --query Account --output text)
ECR_REPO_NAME="$PROJECT_NAME"

log_info "Creating CodeBuild project for Docker build..."

# Create CodeBuild service role
cat > /tmp/codebuild-trust-policy.json << 'EOF'
{
  "Version": "2012-10-17",
  "Statement": [
    {
      "Effect": "Allow",
      "Principal": {
        "Service": "codebuild.amazonaws.com"
      },
      "Action": "sts:AssumeRole"
    }
  ]
}
EOF

# Create IAM role for CodeBuild
aws iam create-role \
  --role-name CodeBuildServiceRole-$PROJECT_NAME \
  --assume-role-policy-document file:///tmp/codebuild-trust-policy.json \
  --region $AWS_REGION 2>/dev/null || true

aws iam attach-role-policy \
  --role-name CodeBuildServiceRole-$PROJECT_NAME \
  --policy-arn arn:aws:iam::aws:policy/AWSCodeBuildDeveloperAccess \
  --region $AWS_REGION 2>/dev/null || true

aws iam attach-role-policy \
  --role-name CodeBuildServiceRole-$PROJECT_NAME \
  --policy-arn arn:aws:iam::aws:policy/AmazonEC2ContainerRegistryPowerUser \
  --region $AWS_REGION 2>/dev/null || true

# Create ECR repository
aws ecr create-repository \
  --repository-name $ECR_REPO_NAME \
  --region $AWS_REGION 2>/dev/null || true

# Create buildspec.yml
cat > buildspec.yml << 'EOF'
version: 0.2
phases:
  pre_build:
    commands:
      - echo Logging in to Amazon ECR...
      - aws ecr get-login-password --region $AWS_DEFAULT_REGION | docker login --username AWS --password-stdin $AWS_ACCOUNT_ID.dkr.ecr.$AWS_DEFAULT_REGION.amazonaws.com
  build:
    commands:
      - echo Build started on `date`
      - echo Building the Docker image...
      - IMAGE_TAG=$(date +%Y%m%d-%H%M%S)
      - docker build -f aws/Dockerfile -t $IMAGE_REPO_URI:$IMAGE_TAG -t $IMAGE_REPO_URI:latest .
  post_build:
    commands:
      - echo Build completed on `date`
      - echo Pushing the Docker images...
      - docker push $IMAGE_REPO_URI:$IMAGE_TAG
      - docker push $IMAGE_REPO_URI:latest
      - echo Writing image definitions file...
      - printf '[{"name":"'$PROJECT_NAME'-container","imageUri":"%s"}]' $IMAGE_REPO_URI:latest > imagedefinitions.json
artifacts:
  files:
    - imagedefinitions.json
EOF

# Create CodeBuild project
aws codebuild create-project \
  --name "$PROJECT_NAME-build" \
  --source type=NO_SOURCE,buildspec=buildspec.yml \
  --artifacts type=NO_ARTIFACTS \
  --environment type=LINUX_CONTAINER,image=aws/codebuild/standard:7.0,computeType=BUILD_GENERAL1_MEDIUM,privilegedMode=true \
  --environment-variables name=AWS_DEFAULT_REGION,value=$AWS_REGION name=AWS_ACCOUNT_ID,value=$AWS_ACCOUNT_ID name=IMAGE_REPO_URI,value=$AWS_ACCOUNT_ID.dkr.ecr.$AWS_REGION.amazonaws.com/$ECR_REPO_NAME \
  --service-role arn:aws:iam::$AWS_ACCOUNT_ID:role/CodeBuildServiceRole-$PROJECT_NAME \
  --region $AWS_REGION 2>/dev/null || true

log_info "Starting CodeBuild..."

# Create a zip of the source code
zip -r source.zip . -x "node_modules/*" ".git/*" "data/*" "dist/*" "*.log"

# Upload to S3 (create bucket if needed)
S3_BUCKET="$PROJECT_NAME-source-$AWS_ACCOUNT_ID"
aws s3 mb s3://$S3_BUCKET --region $AWS_REGION 2>/dev/null || true
aws s3 cp source.zip s3://$S3_BUCKET/source.zip

# Update CodeBuild project to use S3 source
aws codebuild update-project \
  --name "$PROJECT_NAME-build" \
  --source type=S3,location=$S3_BUCKET/source.zip \
  --region $AWS_REGION

# Start the build
BUILD_ID=$(aws codebuild start-build \
  --project-name "$PROJECT_NAME-build" \
  --region $AWS_REGION \
  --query 'build.id' --output text)

log_info "Build started: $BUILD_ID"
log_info "Waiting for build to complete..."

# Wait for build to complete
while true; do
  BUILD_STATUS=$(aws codebuild batch-get-builds \
    --ids $BUILD_ID \
    --region $AWS_REGION \
    --query 'builds[0].buildStatus' --output text)
  
  if [ "$BUILD_STATUS" = "SUCCEEDED" ]; then
    log_success "Build completed successfully!"
    break
  elif [ "$BUILD_STATUS" = "FAILED" ] || [ "$BUILD_STATUS" = "FAULT" ] || [ "$BUILD_STATUS" = "STOPPED" ] || [ "$BUILD_STATUS" = "TIMED_OUT" ]; then
    log_error "Build failed with status: $BUILD_STATUS"
    exit 1
  fi
  
  echo "Build status: $BUILD_STATUS"
  sleep 10
done

# Clean up
rm -f buildspec.yml source.zip /tmp/codebuild-trust-policy.json

log_success "Docker image built and pushed to ECR successfully!"
log_info "Image URI: $AWS_ACCOUNT_ID.dkr.ecr.$AWS_REGION.amazonaws.com/$ECR_REPO_NAME:latest"

echo ""
echo "Now you can deploy the stack:"
echo "./aws/deploy.sh stack"