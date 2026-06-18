#!/bin/bash
set -e

REGION="eu-central-1"
CLUSTER="buzzboard-cluster"

echo "🗑️  Cleaning up Buzzboard AWS resources..."

# 1. Delete ECS services
echo "Deleting ECS services..."
aws ecs update-service --cluster $CLUSTER --service frontend-service --desired-count 0 --region $REGION 2>/dev/null || true
aws ecs update-service --cluster $CLUSTER --service reactions-service --desired-count 0 --region $REGION 2>/dev/null || true
aws ecs update-service --cluster $CLUSTER --service mood-service --desired-count 0 --region $REGION 2>/dev/null || true

sleep 30

aws ecs delete-service --cluster $CLUSTER --service frontend-service --force --region $REGION 2>/dev/null || true
aws ecs delete-service --cluster $CLUSTER --service reactions-service --force --region $REGION 2>/dev/null || true
aws ecs delete-service --cluster $CLUSTER --service mood-service --force --region $REGION 2>/dev/null || true

# 2. Delete ECS cluster
echo "Deleting ECS cluster..."
aws ecs delete-cluster --cluster $CLUSTER --region $REGION 2>/dev/null || true

# 3. Delete API Gateway
echo "Deleting API Gateway..."
API_ID=$(aws apigatewayv2 get-apis --region $REGION --query "Items[?Name=='buzzboard-api'].ApiId" --output text)
[ -n "$API_ID" ] && aws apigatewayv2 delete-api --api-id $API_ID --region $REGION 2>/dev/null || true

# 4. Delete RDS (skip final snapshot)
aws rds delete-db-instance --db-instance-identifier buzzboard-mysql --skip-final-snapshot

# 5. Delete ElastiCache cluster
aws elasticache delete-cache-cluster --cache-cluster-id buzzboard-redis

echo "✅ Cleanup complete!"
echo "Note: Manual verification recommended. Check AWS Console to confirm all resources deleted and to clean up any remaining resources like S3 buckets, CloudWatch logs, VPC and subnets, etc."