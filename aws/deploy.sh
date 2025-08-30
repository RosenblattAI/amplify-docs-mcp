#!/bin/bash

# AWS ECS Fargate Deployment Script for Amplify Docs MCP Server

set -e  # Exit on any error

# Configuration
PROJECT_NAME="amplify-docs-mcp"
AWS_REGION=${AWS_REGION:-us-east-1}
ECR_REPO_NAME=${ECR_REPO_NAME:-$PROJECT_NAME}
STACK_NAME=${STACK_NAME:-$PROJECT_NAME}

# Colors for output
RED='\033[0;31m'
GREEN='\033[0;32m'
YELLOW='\033[1;33m'
BLUE='\033[0;34m'
NC='\033[0m' # No Color

# Logging functions
log_info() {
    echo -e "${BLUE}[INFO]${NC} $1"
}

log_success() {
    echo -e "${GREEN}[SUCCESS]${NC} $1"
}

log_warning() {
    echo -e "${YELLOW}[WARNING]${NC} $1"
}

log_error() {
    echo -e "${RED}[ERROR]${NC} $1"
}

# Check prerequisites
check_prerequisites() {
    log_info "Checking prerequisites..."
    
    # Check AWS CLI
    if ! command -v aws &> /dev/null; then
        log_error "AWS CLI not found. Please install AWS CLI."
        exit 1
    fi
    
    # Check Docker
    if ! command -v docker &> /dev/null; then
        log_error "Docker not found. Please install Docker."
        exit 1
    fi
    
    # Check AWS credentials
    if ! aws sts get-caller-identity &> /dev/null; then
        log_error "AWS credentials not configured. Run 'aws configure' first."
        exit 1
    fi
    
    # Check if we're in the right directory
    if [ ! -f "package.json" ] || [ ! -f "aws/Dockerfile" ]; then
        log_error "Please run this script from the project root directory."
        exit 1
    fi
    
    log_success "Prerequisites check passed"
}

# Get AWS account ID
get_account_id() {
    AWS_ACCOUNT_ID=$(aws sts get-caller-identity --query Account --output text)
    log_info "AWS Account ID: $AWS_ACCOUNT_ID"
}

# Create ECR repository if it doesn't exist
create_ecr_repo() {
    log_info "Creating ECR repository if it doesn't exist..."
    
    if aws ecr describe-repositories --repository-names $ECR_REPO_NAME --region $AWS_REGION &> /dev/null; then
        log_info "ECR repository '$ECR_REPO_NAME' already exists"
    else
        log_info "Creating ECR repository '$ECR_REPO_NAME'..."
        aws ecr create-repository \
            --repository-name $ECR_REPO_NAME \
            --region $AWS_REGION \
            --image-scanning-configuration scanOnPush=true
        log_success "ECR repository created"
    fi
}

# Build and push Docker image
build_and_push_image() {
    log_info "Building and pushing Docker image..."
    
    # Get ECR login token
    aws ecr get-login-password --region $AWS_REGION | docker login --username AWS --password-stdin $AWS_ACCOUNT_ID.dkr.ecr.$AWS_REGION.amazonaws.com
    
    # Build image
    IMAGE_TAG=$(date +%Y%m%d-%H%M%S)
    IMAGE_URI="$AWS_ACCOUNT_ID.dkr.ecr.$AWS_REGION.amazonaws.com/$ECR_REPO_NAME:$IMAGE_TAG"
    LATEST_URI="$AWS_ACCOUNT_ID.dkr.ecr.$AWS_REGION.amazonaws.com/$ECR_REPO_NAME:latest"
    
    log_info "Building Docker image: $IMAGE_URI"
    # Try simple Dockerfile first, fallback to multi-stage if needed
    # Force linux/amd64 platform for AWS Fargate compatibility
    docker build --platform linux/amd64 -f aws/Dockerfile.simple -t $IMAGE_URI -t $LATEST_URI . || \
    docker build --platform linux/amd64 -f aws/Dockerfile -t $IMAGE_URI -t $LATEST_URI .
    
    # Push image
    log_info "Pushing Docker image to ECR..."
    docker push $IMAGE_URI
    docker push $LATEST_URI
    
    log_success "Docker image pushed: $IMAGE_URI"
}

# Get VPC and subnet information
get_vpc_info() {
    log_info "Getting VPC and subnet information..."
    
    # Get the default VPC
    VPC_ID=$(aws ec2 describe-vpcs --filters "Name=is-default,Values=true" --query 'Vpcs[0].VpcId' --output text --region $AWS_REGION)
    
    if [ "$VPC_ID" = "None" ] || [ -z "$VPC_ID" ]; then
        log_error "No default VPC found. Please specify VPC_ID and SUBNET_IDS environment variables."
        exit 1
    fi
    
    # Get public subnets in the VPC
    SUBNET_IDS=$(aws ec2 describe-subnets \
        --filters "Name=vpc-id,Values=$VPC_ID" "Name=default-for-az,Values=true" \
        --query 'Subnets[].SubnetId' \
        --output text --region $AWS_REGION | tr '\t' ',')
    
    if [ -z "$SUBNET_IDS" ]; then
        log_error "No suitable subnets found in VPC $VPC_ID"
        exit 1
    fi
    
    log_info "Using VPC: $VPC_ID"
    log_info "Using Subnets: $SUBNET_IDS"
}

# Deploy CloudFormation stack
deploy_stack() {
    log_info "Deploying CloudFormation stack..."
    
    PARAMETERS=(
        "ParameterKey=ProjectName,ParameterValue=$PROJECT_NAME"
        "ParameterKey=ContainerImage,ParameterValue=$LATEST_URI"
        "ParameterKey=VpcId,ParameterValue=$VPC_ID"
        "ParameterKey=SubnetIds,ParameterValue=\"$SUBNET_IDS\""
        "ParameterKey=AmplifyGeneration,ParameterValue=${AMPLIFY_GENERATION:-gen2}"
        "ParameterKey=AutoUpdateInterval,ParameterValue=${AUTO_UPDATE_INTERVAL:-60}"
    )
    
    # Check if stack exists
    if aws cloudformation describe-stacks --stack-name $STACK_NAME --region $AWS_REGION &> /dev/null; then
        log_info "Updating existing stack '$STACK_NAME'..."
        aws cloudformation update-stack \
            --stack-name $STACK_NAME \
            --template-body file://aws/cloudformation.yaml \
            --parameters "${PARAMETERS[@]}" \
            --capabilities CAPABILITY_IAM \
            --region $AWS_REGION
        
        log_info "Waiting for stack update to complete..."
        aws cloudformation wait stack-update-complete --stack-name $STACK_NAME --region $AWS_REGION
    else
        log_info "Creating new stack '$STACK_NAME'..."
        aws cloudformation create-stack \
            --stack-name $STACK_NAME \
            --template-body file://aws/cloudformation.yaml \
            --parameters "${PARAMETERS[@]}" \
            --capabilities CAPABILITY_IAM \
            --region $AWS_REGION
        
        log_info "Waiting for stack creation to complete..."
        aws cloudformation wait stack-create-complete --stack-name $STACK_NAME --region $AWS_REGION
    fi
    
    log_success "CloudFormation stack deployed successfully"
}

# Get stack outputs
get_stack_outputs() {
    log_info "Getting stack outputs..."
    
    ALB_URL=$(aws cloudformation describe-stacks \
        --stack-name $STACK_NAME \
        --query 'Stacks[0].Outputs[?OutputKey==`LoadBalancerURL`].OutputValue' \
        --output text --region $AWS_REGION)
    
    ALB_DNS=$(aws cloudformation describe-stacks \
        --stack-name $STACK_NAME \
        --query 'Stacks[0].Outputs[?OutputKey==`LoadBalancerDNSName`].OutputValue' \
        --output text --region $AWS_REGION)
    
    echo ""
    log_success "Deployment completed successfully!"
    echo ""
    echo "🚀 Your Amplify Docs MCP Server is now running on AWS ECS Fargate!"
    echo ""
    echo "📡 HTTP API Endpoint:"
    echo "   $ALB_URL"
    echo ""
    echo "🔍 Test the deployment:"
    echo "   curl \"$ALB_URL/health\""
    echo "   curl \"$ALB_URL/search?query=authentication\""
    echo ""
    echo "📋 For Cloudflare Worker integration:"
    echo "   wrangler secret put MCP_SERVER_URL"
    echo "   # Enter: $ALB_URL"
    echo ""
    echo "💰 Estimated monthly cost: \$20-50 (depending on usage)"
    echo ""
    echo "🛠️  To update the deployment:"
    echo "   ./aws/deploy.sh"
    echo ""
    echo "🗑️  To delete the deployment:"
    echo "   aws cloudformation delete-stack --stack-name $STACK_NAME --region $AWS_REGION"
    echo ""
}

# Main deployment flow
main() {
    log_info "Starting AWS ECS Fargate deployment for $PROJECT_NAME"
    
    check_prerequisites
    get_account_id
    create_ecr_repo
    build_and_push_image
    get_vpc_info
    deploy_stack
    get_stack_outputs
}

# Handle script arguments
case "${1:-deploy}" in
    "deploy")
        main
        ;;
    "build")
        check_prerequisites
        get_account_id
        create_ecr_repo
        build_and_push_image
        ;;
    "stack")
        check_prerequisites
        get_vpc_info
        deploy_stack
        get_stack_outputs
        ;;
    "outputs")
        get_stack_outputs
        ;;
    "delete")
        log_warning "Deleting stack '$STACK_NAME'..."
        aws cloudformation delete-stack --stack-name $STACK_NAME --region $AWS_REGION
        log_info "Waiting for stack deletion to complete..."
        aws cloudformation wait stack-delete-complete --stack-name $STACK_NAME --region $AWS_REGION
        log_success "Stack deleted successfully"
        ;;
    *)
        echo "Usage: $0 [deploy|build|stack|outputs|delete]"
        echo ""
        echo "Commands:"
        echo "  deploy  - Full deployment (build + push + deploy stack)"
        echo "  build   - Build and push Docker image only"  
        echo "  stack   - Deploy CloudFormation stack only"
        echo "  outputs - Show stack outputs"
        echo "  delete  - Delete the CloudFormation stack"
        exit 1
        ;;
esac