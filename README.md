# Buzzboard on AWS

A production-grade 3-tier microservices application deployed on AWS using ECS Fargate, RDS, and ElastiCache. This project demonstrates secure networking, high availability, cost optimization, and infrastructure best practices.

![AWS](https://img.shields.io/badge/AWS-ECS_Fargate-FF9900?style=flat-square)
![Architecture](https://img.shields.io/badge/Architecture-3--Tier--Microservices-blue?style=flat-square)
![License](https://img.shields.io/badge/License-MIT-green?style=flat-square)

## Overview

Buzzboard is a real-time mood and reactions wall application. Users can:
- Sign up / sign in (JWT-based authentication)
- Post reactions (stored in MySQL, cached in Redis)
- Post their mood of the day (aggregated in real-time)

This repository contains the complete deployment guides, and application code for running Buzzboard on AWS. (You Can Check Everything in docs folder)

**Original source:** [buzzboard-k8s](https://github.com/yahiax20/buzzboard-k8s) (Kubernetes/k3s version)

## Architecture

![Architecture](/docs/Architecture/Architecture.png)
*Project Architecture*

**Key design decisions:**
- **Private networking:** No public subnets. All outbound traffic to AWS services goes through VPC Endpoints (ECR, CloudWatch, Secrets Manager).
- **No NAT Gateway:** Saves ~$45/month. VPC Endpoints are cheaper and more secure.
- **Single-AZ data:** Free tier compatible. Compute spans two AZs for ALB requirement.
- **Secrets Management:** RDS and Redis credentials stored in AWS Secrets Manager, not in code or environment variables.
- **CloudWatch integration:** All container logs centralized, alarms trigger email via SNS.

## Prerequisites

- AWS Account (free tier eligible)
- AWS CLI v2 configured
- Docker installed locally
- Git

## Getting Started

### 1. Clone the Repository

```bash
git clone https://github.com/yourusername/buzzboard-aws.git
cd buzzboard-aws
```

### 2. Set Environment Variables

Create a `.env.local` file (for local testing, not used in deployment):

```bash
MYSQL_HOST=localhost
MYSQL_USER=buzzboard
MYSQL_PASSWORD=buzzboard-secret
MYSQL_DATABASE=buzzboard
REDIS_HOST=localhost
REDIS_PASSWORD=buzzboard-redis-secret
JWT_SECRET=your-secret-key-change-in-production
PORT=8081  # for reactions; 8082 for mood
```

### 3. Run Locally (Optional)

If you want to test the app before deploying to AWS:

```bash
# Start Redis and MySQL with Docker Compose
docker-compose up -d redis mysql

# In terminal 1: Start reactions service
cd backend/reactions && npm install
export $(cat ../.env.local | xargs) && npm start

# In terminal 2: Start mood service
cd backend/mood && npm install
export $(cat ../.env.local | xargs) && npm start

# In terminal 3: Serve frontend
cp frontend/public/config.local.js frontend/public/config.js
npx serve frontend/public -l 3000
```

Open [http://localhost:3000](http://localhost:3000).

### 4. Deploy to AWS

See [docs/DEPLOYMENT.md](docs/DEPLOYMENT.md) for complete step-by-step instructions.

**Quick overview:**

1. Create VPC + 4 private subnets
2. Create RDS MySQL and ElastiCache Redis
3. Push Docker images to ECR
4. Create ECS cluster, task definitions, services
5. Create Internal ALB with path-based routing
6. Create API Gateway + VPC Link
7. Update frontend config with API Gateway URL
8. Deploy frontend service
9. Configure CloudWatch alarms

Expected deployment time: **45–60 minutes**


## Configuration

### Frontend Config (Important!)

The frontend is a static Nginx application. It needs the API Gateway URL hardcoded at **build time**.

Edit `frontend/public/config.docker.js`:

```javascript
// config.docker.js — used when building Docker image for AWS
const CONFIG = {
  REACTIONS_API_URL: "https://your-api-id.execute-api.eu-central-1.amazonaws.com",
  MOOD_API_URL: "https://your-api-id.execute-api.eu-central-1.amazonaws.com"
};
```

> **Why hardcode?** The browser needs a public URL to call your backend. The internal ALB is private and unreachable from the internet. API Gateway is the public entry point.

### Environment Variables

| Service | Variable | Source | Example |
|---------|----------|--------|---------|
| reactions, mood | `MYSQL_HOST` | Secrets Manager or plain | `buzzboard-mysql.xxxx.rds.amazonaws.com` |
| reactions, mood | `MYSQL_USER` | Secrets Manager | `buzzboard` |
| reactions, mood | `MYSQL_PASSWORD` | Secrets Manager | — |
| reactions, mood | `MYSQL_DATABASE` | Secrets Manager | `buzzboard` |
| reactions, mood | `REDIS_HOST` | Secrets Manager | `buzzboard-redis.xxxx.cache.amazonaws.com` |
| reactions, mood | `REDIS_PASSWORD` | Secrets Manager | — |
| reactions, mood | `JWT_SECRET` | Secrets Manager | — |
| reactions | `PORT` | Plain env var | `8081` |
| mood | `PORT` | Plain env var | `8082` |

## Deployment Notes

### VPC & Networking

- **VPC CIDR:** `10.0.0.0/16`
- **Subnets:** 4 private subnets across 2 AZs
  - `compute-subnet-a` (10.0.1.0/24) — ECS tasks
  - `compute-subnet-b` (10.0.2.0/24) — ECS tasks + ALB (required for 2 AZ)
  - `data-subnet-a` (10.0.3.0/24) — RDS
  - `data-subnet-b` (10.0.4.0/24) — Redis
- **No internet gateway or NAT:** All AWS service calls go through VPC Endpoints.

### Security Groups

Minimum required (all in same VPC):

| SG | Inbound | Source |
|----|---------|--------|
| `sg-alb` | HTTP 80 | `sg-vpclink` |
| `sg-ecs` | TCP 80, 8081, 8082 | `sg-alb` |
| `sg-rds` | MySQL 3306 | `sg-ecs` |
| `sg-redis` | Redis 6379 | `sg-ecs` |
| `sg-endpoints` | HTTPS 443 | `sg-ecs` |
| `sg-vpclink` | — (outbound only) | outbound to `sg-alb`:80 |

### VPC Endpoints

Required so ECS tasks can pull images and write logs:

- `ecr.api` — ECR authentication
- `ecr.dkr` — Pull Docker images
- `logs` — CloudWatch Logs
- `secretsmanager` — Fetch credentials
- `s3` (gateway) — ECR image layers

Cost: ~$1/day for 24 hours (vs. $45/month for NAT Gateway).

### Cost Breakdown (24 hours, free tier)

| Component | Cost |
|-----------|------|
| ECS Fargate (3 tasks) | $1.62 |
| Internal ALB | $0.54 |
| RDS MySQL | $0.41 (free tier) |
| ElastiCache Redis | $0.82 (free tier) |
| VPC Endpoints (4x) | $0.96 |
| **Total** | **~$4.35** |

**For new AWS accounts:** Free tier ($100 credit) + free tier RDS/Redis (750h/month) = **potentially $0**.

## Testing

After deployment, verify the app works:

```bash
# 1. Test API Gateway
API_URL="https://your-api-id.execute-api.eu-central-1.amazonaws.com"

curl -X POST $API_URL/api/reactions \
  -H "Content-Type: application/json" \
  -d '{
    "email": "test@example.com",
    "password": "test123",
    "action": "signup"
  }'

# 2. Check ECS tasks are running
aws ecs list-tasks --cluster buzzboard-cluster --region eu-central-1

# 3. View logs
aws logs tail /ecs/buzzboard-reactions --follow --region eu-central-1

# 4. Check health of target groups
aws elbv2 describe-target-health \
  --target-group-arn arn:aws:elasticloadbalancing:... \
  --region eu-central-1
```

## Troubleshooting

### Tasks Won't Start

**Error:** `CannotPullContainerError`

- **Cause:** Missing VPC Endpoints for ECR.
- **Fix:** Create interface endpoints for `ecr.api` and `ecr.dkr` in compute subnets. Also create S3 gateway endpoint.

### Database Connection Fails

**Error:** `MYSQL_HOST` resolves to JSON object instead of hostname.

- **Cause:** Secrets Manager extraction syntax missing `::` suffix.
- **Fix:** Use `arn:aws:secretsmanager:...:buzzboard/mysql:MYSQL_HOST::` (note the double colon at end).

### Frontend Can't Call Backend

**Error:** API calls return 503 or timeout.

- **Cause:** VPC Link security group has no outbound rule to ALB.
- **Fix:** Add outbound rule in `sg-vpclink`: TCP 80 → `sg-alb`.

### Alarms Keep Firing

**Error:** Unnecessary CloudWatch alarms waking you up.

- **Fix:** Increase threshold (e.g., CPU > 85% instead of 75%) or add to SNS topic only during business hours.

For more, see [docs/TROUBLESHOOTING.md](docs/TROUBLESHOOTING.md).

## Cleanup

To avoid ongoing charges, tear down resources:

```bash
# Automated cleanup, you have to make sure that it worked.
bash scripts/cleanup.sh

# Or manually (order matters):
# 1. Delete ECS services and cluster
# 2. Delete API Gateway
# 3. Delete VPC Link
# 4. Delete ALB and target groups
# 5. Delete RDS instance
# 6. Delete ElastiCache cluster
# 7. Delete VPC Endpoints
# 8. Delete Security Groups and VPC
```

See [docs/DEPLOYMENT.md#cleanup](docs/DEPLOYMENT.md) for detailed AWS CLI commands.

## Architecture Decisions

### Why ECS Fargate ?

- **Cost-effective:** Fargate runs containers without managing servers. ~$0.04/hour for 0.5 vCPU + 1GB.
- **Minimal ops:** Auto-restart, health checks, scaling built-in. No cluster management overhead.
- **Simple integration:** Works seamlessly with ALB, API Gateway, CloudWatch.

### Why Internal ALB ?

- **Path-based routing:** Route `/api/reactions/*` to reactions service, `/api/mood/*` to mood service.
- **Health checks:** ALB verifies tasks are healthy before sending traffic.
- **Sticky sessions:** Optional session persistence if needed later.

### Why VPC Endpoints (not NAT Gateway)?

- **Cost:** Endpoints ~$0.01/hour vs. NAT ~$0.045/hour + data transfer charges.
- **Security:** No internet exposure. Direct private tunnel to AWS services.
- **Simplicity:** No subnet management, no gateway routing complexity.

### Why Secrets Manager (not Lambda environment variables)?

- **Rotation:** Credentials can be rotated without redeploying.
- **Audit trail:** CloudTrail logs all secret access.
- **Separation:** Secrets never appear in logs, task definitions, or shell history.

## Contributing

This is a personal portfolio project. Feel free to fork and adapt for your own deployments.

### Improvements Welcome

- Add Terraform or CloudFormation templates
- Add CI/CD pipeline (GitHub Actions)
- Add auto-scaling based on metrics
- Add WAF rules to API Gateway

P.S. I'll Add Terraform Template later after studying it.


## Author

- **Yahia Hamdy** — [GitHub](https://github.com/yahiax20) | [LinkedIn](https://www.linkedin.com/in/yahia-hamdy-676591204)

Originally adapted from the Kubernetes version of Buzzboard.

---

## Related Resources

- [AWS ECS Best Practices](https://docs.aws.amazon.com/AmazonECS/latest/bestpracticesguide/intro.html)
- [VPC Endpoints Guide](https://docs.aws.amazon.com/vpc/latest/privatelink/vpc-endpoints.html)
- [Secrets Manager Documentation](https://docs.aws.amazon.com/secretsmanager/)
- [Original Buzzboard K8s Project](https://github.com/yahiax20/buzzboard-k8s)
