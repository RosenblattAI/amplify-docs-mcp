# AWS Deployment Guide

## Best AWS Option: ECS Fargate + Application Load Balancer

This is the **optimal AWS deployment** for the Amplify Documentation MCP Server. Here's why:

### Why ECS Fargate is Perfect
✅ **Large containers** - Supports up to 10GB (handles Git repos)  
✅ **Long-running processes** - Perfect for MCP stdio transport  
✅ **Persistent storage** - EFS for Git repository caching across restarts  
✅ **Auto-scaling** - Scales based on CPU/memory/requests  
✅ **No server management** - Fully managed containers  
✅ **Multi-protocol** - Runs both MCP (stdio) and HTTP simultaneously  
✅ **Cost efficient** - Pay only for what you use  

## Architecture

```
Internet → ALB → ECS Fargate → EFS (persistent Git repos)
                     ├── HTTP Adapter (port 3000)
                     └── MCP Server (stdio)
```

### Components
- **Application Load Balancer**: Public HTTP endpoint with health checks
- **ECS Fargate**: Serverless container runtime
- **Container**: Runs both HTTP adapter and MCP server
- **EFS**: Persistent storage for Git repositories (shared across restarts)
- **Auto Scaling**: Scales 1-10 containers based on CPU usage
- **Security Groups**: Controlled network access

## Quick Deploy

### Prerequisites
```bash
# Install AWS CLI
curl "https://awscli.amazonaws.com/awscli-exe-linux-x86_64.zip" -o "awscliv2.zip"
unzip awscliv2.zip && sudo ./aws/install

# Configure AWS credentials
aws configure
# Enter: Access Key, Secret Key, Region (e.g., us-east-1), Output format (json)

# Install Docker
# (Installation varies by OS - see Docker documentation)
```

### One-Command Deployment
```bash
# Deploy everything (build image + create infrastructure)
npm run deploy:aws

# Or run the script directly
./aws/deploy.sh
```

That's it! The script will:
1. ✅ Build and push Docker image to ECR
2. ✅ Create VPC, Load Balancer, ECS Cluster, EFS storage
3. ✅ Deploy your container with auto-scaling
4. ✅ Provide you with the public endpoint URL

## Configuration Options

### Environment Variables (set before deploying)

```bash
# AWS Configuration
export AWS_REGION=us-east-1              # AWS region
export PROJECT_NAME=amplify-docs-mcp     # Resource naming prefix
export STACK_NAME=amplify-docs-mcp       # CloudFormation stack name

# Application Configuration  
export AMPLIFY_GENERATION=gen2           # gen1, gen2, or both
export AUTO_UPDATE_INTERVAL=60           # Auto-update interval (minutes)

# Then deploy
./aws/deploy.sh
```

### Resource Sizing
The default configuration uses:
- **CPU**: 1 vCPU (1024 CPU units)
- **Memory**: 2 GB (2048 MB)
- **Auto Scaling**: 1-10 containers
- **Storage**: EFS (pay-per-use)

To customize, edit `aws/cloudformation.yaml`:
```yaml
Cpu: 2048     # 2 vCPU
Memory: 4096  # 4 GB
```

## Usage After Deployment

### HTTP API Endpoints
```bash
# Get your deployment URL (shown after deployment)
ENDPOINT="http://your-alb-1234567890.us-east-1.elb.amazonaws.com"

# Health check
curl "$ENDPOINT/health"

# Search documentation
curl "$ENDPOINT/search?query=authentication"

# Advanced search
curl -X POST "$ENDPOINT/search" \
  -H "Content-Type: application/json" \
  -d '{
    "query": "create api graphql",
    "includeContent": true,
    "maxResults": 5
  }'
```

### MCP Protocol Access
The MCP server runs alongside the HTTP adapter. To access it:

```bash
# Option 1: SSH tunnel (for local MCP clients)
aws ecs execute-command \
  --cluster amplify-docs-mcp-cluster \
  --task <task-id> \
  --container amplify-docs-mcp-container \
  --interactive \
  --command "/bin/sh"

# Option 2: ECS Exec (requires ECS Exec enabled)
# See: https://docs.aws.amazon.com/AmazonECS/latest/developerguide/ecs-exec.html
```

### Integrate with Cloudflare Worker
```bash
# Set your AWS endpoint as the MCP server URL
wrangler secret put MCP_SERVER_URL
# Enter: http://your-alb-1234567890.us-east-1.elb.amazonaws.com

# Deploy Cloudflare Worker for global edge caching
wrangler deploy
```

## Management Commands

```bash
# Full deployment (recommended)
npm run deploy:aws

# Build and push image only
npm run deploy:aws-build

# Deploy infrastructure only (use existing image)
npm run deploy:aws-stack

# Show deployment outputs
./aws/deploy.sh outputs

# Delete everything
npm run deploy:aws-delete
```

## Monitoring & Debugging

### CloudWatch Logs
```bash
# View logs
aws logs tail /ecs/amplify-docs-mcp --follow

# Or use AWS Console:
# CloudWatch → Log Groups → /ecs/amplify-docs-mcp
```

### Health Monitoring
```bash
# Check ALB target health
aws elbv2 describe-target-health \
  --target-group-arn $(aws elbv2 describe-target-groups \
    --names amplify-docs-mcp-tg \
    --query 'TargetGroups[0].TargetGroupArn' \
    --output text)

# Check ECS service status
aws ecs describe-services \
  --cluster amplify-docs-mcp-cluster \
  --services amplify-docs-mcp-service
```

### Auto Scaling Metrics
The service automatically scales based on:
- **Target**: 70% CPU utilization
- **Scale Out**: When CPU > 70% for 5 minutes
- **Scale In**: When CPU < 70% for 5 minutes
- **Limits**: 1-10 containers

View scaling activity:
```bash
aws application-autoscaling describe-scaling-activities \
  --service-namespace ecs \
  --resource-id service/amplify-docs-mcp-cluster/amplify-docs-mcp-service
```

## Cost Estimation

### Monthly Costs (us-east-1, approximate)
- **ECS Fargate**: $15-30/month (1 container, 1 vCPU, 2GB)
- **Application Load Balancer**: $18/month (fixed cost)
- **EFS Storage**: $1-5/month (depends on repo size)
- **Data Transfer**: $1-10/month (depends on usage)
- **CloudWatch**: $1-5/month (logs and metrics)

**Total: ~$35-70/month** for a production deployment

### Cost Optimization Tips
1. **Use Fargate Spot**: 50-70% cost savings
   ```yaml
   # In cloudformation.yaml
   CapacityProviders:
     - FARGATE_SPOT  # Add this
   ```

2. **Optimize Container Size**: Start small, scale up if needed
3. **Use CloudWatch Insights**: Reduce log retention to 3-7 days
4. **Schedule Scaling**: Scale down during low-usage hours

## Security Best Practices

### Network Security
- ✅ ALB only accepts HTTP/HTTPS traffic
- ✅ ECS tasks only accept traffic from ALB
- ✅ EFS only accepts traffic from ECS tasks
- ✅ All components in private subnets (except ALB)

### Data Security
- ✅ EFS encryption at rest and in transit
- ✅ ECR image scanning enabled
- ✅ IAM roles with minimal permissions
- ✅ VPC security groups with least privilege

### Additional Security (Optional)
```bash
# Enable GuardDuty for threat detection
aws guardduty create-detector --enable

# Enable AWS Config for compliance monitoring
aws configservice put-configuration-recorder --configuration-recorder name=default,roleARN=arn:aws:iam::ACCOUNT:role/aws-config-role

# Enable CloudTrail for API logging
aws cloudtrail create-trail --name amplify-docs-mcp-trail
```

## Troubleshooting

### Common Issues

1. **"No default VPC found"**
   ```bash
   # Create a VPC manually or specify existing VPC
   export VPC_ID=vpc-12345678
   export SUBNET_IDS=subnet-12345678,subnet-87654321
   ./aws/deploy.sh
   ```

2. **"Docker build failed"**
   ```bash
   # Build locally first
   docker build -f aws/Dockerfile -t test-build .
   ```

3. **"Health check failing"**
   ```bash
   # Check container logs
   aws logs tail /ecs/amplify-docs-mcp --follow
   
   # Check if Git clone is working
   curl "http://your-alb.elb.amazonaws.com/health"
   ```

4. **"Out of memory errors"**
   ```yaml
   # Increase memory in cloudformation.yaml
   Memory: 4096  # 4 GB instead of 2 GB
   ```

### Debug Container Locally
```bash
# Build and run locally
docker build -f aws/Dockerfile -t amplify-docs-local .
docker run -p 3000:3000 -e NODE_ENV=development amplify-docs-local

# Test endpoints
curl http://localhost:3000/health
curl http://localhost:3000/search?query=auth
```

## Comparison with Other Options

| Option | Pros | Cons | Cost/Month |
|--------|------|------|------------|
| **ECS Fargate** | No server management, auto-scaling, persistent storage | More AWS complexity | $35-70 |
| **Lambda** | Serverless, pay-per-request | Cold starts, size limits, no stdio | $5-20 |
| **EC2** | Full control, cheaper for high usage | Server management, manual scaling | $20-100 |
| **Railway** | Simple deployment, good for prototypes | Less control, vendor lock-in | $5-20 |

## Support

### AWS Resources
- [ECS Fargate Documentation](https://docs.aws.amazon.com/AmazonECS/latest/developerguide/AWS_Fargate.html)
- [Application Load Balancer Guide](https://docs.aws.amazon.com/elasticloadbalancing/latest/application/)
- [EFS User Guide](https://docs.aws.amazon.com/efs/latest/ug/)

### Getting Help
1. Check CloudWatch logs first
2. Review the health check endpoint
3. Verify Git repository access
4. Check AWS service limits

This AWS deployment provides enterprise-grade hosting for your Amplify Documentation MCP Server with high availability, auto-scaling, and persistent storage - perfect for production use!