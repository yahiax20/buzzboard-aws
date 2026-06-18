# Deployment Guide

Complete step-by-step instructions for deploying Buzzboard to AWS using ECS Fargate, RDS MySQL, and ElastiCache Redis.

## Prerequisites

- AWS account (free tier eligible)
- AWS CLI v2 configured with credentials
- Docker installed locally
- Git
- Text editor (VS Code, etc.)
- Estimated time: 60 minutes

## Architecture Overview

```
Internet User → API Gateway (public) → VPC Link → Internal ALB → ECS Tasks
                                                        ↓
                                        RDS MySQL (data subnet)
                                        ElastiCache Redis (data subnet)
```

**Key principle:** All resources in private subnets. No internet gateway. VPC Endpoints replace NAT Gateway for cost savings.

---

## Phase 1: Foundation (VPC & Networking)

### Step 1.1: Create VPC

**AWS Console → VPC → Create VPC**

| Setting | Value |
|---------|-------|
| Name | `buzzboardVpc` |
| CIDR Block | `10.0.0.0/16` |
| Tenancy | Default |
| DNS Resolution | Enabled |
| DNS Hostnames | Enabled |

Click **Create VPC**.

### Step 1.2: Create 4 Private Subnets

**VPC → Subnets → Create Subnet**

Create these 4 subnets (all in the same VPC):

| Subnet Name | CIDR | AZ | Type |
|-------------|------|----|----|
| `compute-subnet-a` | `10.0.1.0/24` | eu-central-1a | Compute (ECS) |
| `compute-subnet-b` | `10.0.2.0/24` | eu-central-1b | Compute (ECS) |
| `data-subnet-a` | `10.0.3.0/24` | eu-central-1a | Data (RDS) |
| `data-subnet-b` | `10.0.4.0/24` | eu-central-1b | Data (Redis) |

For each subnet:
- VPC: `buzzboardVpc`
- Enable auto-assign public IP: **OFF**
- Click **Create Subnet**

### Step 1.3: Create Private Route Table

**VPC → Route Tables → Create Route Table**

| Setting | Value |
|---------|-------|
| Name | `private-rt` |
| VPC | `buzzboardVpc` |

Click **Create Route Table**.

Then associate all 4 subnets to this route table:
- Route Table → Actions → Edit Subnet Associations
- Select all 4 subnets → Save

**Result:** All traffic stays local (10.0.0.0/16). No 0.0.0.0/0 route to internet.

---

## Phase 2: Security Groups

**EC2 → Security Groups → Create Security Group** (repeat for each)

### SG 1: `buzzboard-alb-sg`

| Direction | Protocol | Port | Source |
|-----------|----------|------|--------|
| Inbound | TCP | 80 | `buzzboard-vpclink-sg` |
| Outbound | All | All | 0.0.0.0/0 |

### SG 2: `buzzboard-ecs-tasks-sg`

| Direction | Protocol | Port | Source |
|-----------|----------|------|--------|
| Inbound | TCP | 80 | `buzzboard-alb-sg` |
| Inbound | TCP | 8081 | `buzzboard-alb-sg` |
| Inbound | TCP | 8082 | `buzzboard-alb-sg` |
| Outbound | All | All | 0.0.0.0/0 |

### SG 3: `buzzboard-rds-sg`

| Direction | Protocol | Port | Source |
|-----------|----------|------|--------|
| Inbound | TCP | 3306 | `buzzboard-ecs-tasks-sg` |
| Outbound | All | All | 0.0.0.0/0 |

### SG 4: `buzzboard-redis-sg`

| Direction | Protocol | Port | Source |
|-----------|----------|------|--------|
| Inbound | TCP | 6379 | `buzzboard-ecs-tasks-sg` |
| Outbound | All | All | 0.0.0.0/0 |

### SG 5: `buzzboard-vpclink-sg`

| Direction | Protocol | Port | Destination |
|-----------|----------|------|-------------|
| Outbound | TCP | 80 | `buzzboard-alb-sg` |

### SG 6: `buzzboard-endpoints-sg`

| Direction | Protocol | Port | Source |
|-----------|----------|------|--------|
| Inbound | TCP | 443 | `buzzboard-ecs-tasks-sg` |
| Outbound | All | All | 0.0.0.0/0 |

---

## Phase 3: Database Tier

### Step 3.1: Create RDS DB Subnet Group

**RDS → Subnet Groups → Create DB Subnet Group**

| Setting | Value |
|---------|-------|
| Name | `buzzboard-db-subnet-group` |
| Description | Database subnets for Buzzboard |
| VPC | `buzzboardVpc` |
| Subnets | `data-subnet-a`, `data-subnet-b` |

### Step 3.2: Create RDS MySQL Instance

**RDS → Create Database**

| Setting | Value |
|---------|-------|
| Engine | MySQL 8.0 |
| Template | Free tier |
| DB instance ID | `buzzboard-mysql` |
| Master username | `buzzboard` |
| Master password | `(save this!)` |
| Instance class | db.t3.micro |
| Storage | 20 GB gp2 |
| VPC | `buzzboardVpc` |
| DB subnet group | `buzzboard-db-subnet-group` |
| Security group | `buzzboard-rds-sg` |
| Database name | `buzzboard` |
| Multi-AZ | No |
| Backup retention | 7 days |

Wait for status `available` (~5 minutes).

**Save the endpoint:** It looks like `buzzboard-mysql.xxxx.eu-central-1.rds.amazonaws.com`

### Step 3.3: Create ElastiCache Redis

**ElastiCache → Create Redis Cluster**

First, create a subnet group:
- ElastiCache → Subnet Groups → Create
- Name: `buzzboard-redis-subnet-group`
- VPC: `buzzboardVpc`
- Subnets: `data-subnet-a`, `data-subnet-b`

Then create the cluster:

| Setting | Value |
|---------|-------|
| Cluster mode | Disabled |
| Name | `buzzboard-redis` |
| Engine version | 7.0 |
| Node type | cache.t3.micro |
| Number of replicas | 1 |
| Subnet group | `buzzboard-redis-subnet-group` |
| Security group | `buzzboard-redis-sg` |
| Multi-AZ | Enabled |
| Auth token | `buzzboard-redis-secret` | X dont do it 
| In-transit encryption | Enabled |

Wait for status `available`.

**Save the Primary Endpoint:** It looks like `buzzboard-redis.xxxx.cache.amazonaws.com`

---

## Phase 4: Secrets & IAM

### Step 4.1: Create Secrets Manager Secrets

**Secrets Manager → Store a new secret**

**Secret 1: `buzzboard/mysql`**
```json
{
  "MYSQL_HOST": "buzzboard-mysql.xxxx.eu-central-1.rds.amazonaws.com",
  "MYSQL_USER": "buzzboard",
  "MYSQL_PASSWORD": "your-rds-password",
  "MYSQL_DATABASE": "buzzboard"
}
```

**Secret 2: `buzzboard/redis`**
```json
{
  "REDIS_HOST": "buzzboard-redis.xxxx.cache.amazonaws.com",
  "REDIS_PASSWORD": "buzzboard-redis-secret",
  "REDIS_PORT": "6379"
}
```

**Secret 3: `buzzboard/app`**
```json
{
  "JWT_SECRET": "your-strong-jwt-secret-here"
}
```

### Step 4.2: Create IAM Roles

**IAM → Roles → Create Role**

**Role 1: `buzzboard-ecs-execution-role`**
- Trust: ECS Tasks
- Attach policy: `AmazonECSTaskExecutionRolePolicy`
- Add inline policy:
```json
{
  "Version": "2012-10-17",
  "Statement": [{
    "Effect": "Allow",
    "Action": "secretsmanager:GetSecretValue",
    "Resource": "arn:aws:secretsmanager:eu-central-1:YOUR_ACCOUNT_ID:secret:buzzboard/*"
  }]
}
```

**Role 2: `buzzboard-ecs-task-role`**
- Trust: ECS Tasks
- No policies needed (app doesn't call AWS SDK)

---

## Phase 5: VPC Endpoints

**VPC → Endpoints → Create Endpoint** (repeat for each)

### Interface Endpoints (Attach to compute subnets)

1. **vpce-ecr-api**
   - Service: `com.amazonaws.eu-central-1.ecr.api`
   - Subnets: `compute-subnet-a`, `compute-subnet-b`
   - Security group: `buzzboard-endpoints-sg`
   - Enable Private DNS: Yes

2. **vpce-ecr-dkr**
   - Service: `com.amazonaws.eu-central-1.ecr.dkr`
   - Same subnet/SG as above
   - Enable Private DNS: Yes

3. **vpce-logs**
   - Service: `com.amazonaws.eu-central-1.logs`
   - Same subnet/SG as above
   - Enable Private DNS: Yes

4. **vpce-secretsmanager**
   - Service: `com.amazonaws.eu-central-1.secretsmanager`
   - Same subnet/SG as above
   - Enable Private DNS: Yes

### Gateway Endpoint

5. **vpce-s3**
   - Service: `com.amazonaws.eu-central-1.s3`
   - Route table: `private-rt`

---

## Phase 6: ECR & Docker Images

### Step 6.1: Create ECR Repositories

**ECR → Create Repository** (repeat 3 times)

1. Name: `buzzboard-reactions`
2. Name: `buzzboard-mood`
3. Name: `buzzboard-frontend`

### Step 6.2: Push Images

```bash
# Get AWS account ID
ACCOUNT_ID=$(aws sts get-caller-identity --query Account --output text)
REGION="eu-central-1"

# Login to ECR
aws ecr get-login-password --region $REGION | \
  docker login --username AWS --password-stdin $ACCOUNT_ID.dkr.ecr.$REGION.amazonaws.com

# Build and push reactions
cd backend/reactions
docker build --platform linux/amd64 -t buzzboard-reactions .
docker tag buzzboard-reactions:latest \
  $ACCOUNT_ID.dkr.ecr.$REGION.amazonaws.com/buzzboard-reactions:latest
docker push $ACCOUNT_ID.dkr.ecr.$REGION.amazonaws.com/buzzboard-reactions:latest

# Build and push mood
cd ../mood
docker build --platform linux/amd64 -t buzzboard-mood .
docker tag buzzboard-mood:latest \
  $ACCOUNT_ID.dkr.ecr.$REGION.amazonaws.com/buzzboard-mood:latest
docker push $ACCOUNT_ID.dkr.ecr.$REGION.amazonaws.com/buzzboard-mood:latest

# Build and push frontend (AFTER Step 8 with API Gateway URL)
cd ../frontend
docker build --platform linux/amd64 -t buzzboard-frontend .
docker tag buzzboard-frontend:latest \
  $ACCOUNT_ID.dkr.ecr.$REGION.amazonaws.com/buzzboard-frontend:latest
docker push $ACCOUNT_ID.dkr.ecr.$REGION.amazonaws.com/buzzboard-frontend:latest
```

> **Note:** Use `--platform linux/amd64` if building on Apple Silicon Mac.

---

## Phase 7: Load Balancing & ECS

### Step 7.1: Create Internal ALB

**EC2 → Load Balancers → Create Application Load Balancer**

| Setting | Value |
|---------|-------|
| Name | `buzzboard-internal-alb` |
| Scheme | Internal |
| VPC | `buzzboardVpc` |
| Subnets | `compute-subnet-a`, `compute-subnet-b` |
| Security group | `buzzboard-alb-sg` |
| Listener | HTTP:80 |

Create a dummy target group (forward to), then create.

### Step 7.2: Create Target Groups

**EC2 → Target Groups → Create Target Group** (repeat 3 times)

| Name | Port | Protocol | Target Type |
|------|------|----------|-------------|
| `reactions-tg` | 8081 | HTTP | IP |
| `mood-tg` | 8082 | HTTP | IP |
| `frontend-tg` | 80 | HTTP | IP |

For each, set Health check: Path `/`, Interval 30s, Timeout 5s.

### Step 7.3: Create ECS Cluster

**ECS → Clusters → Create Cluster**

| Setting | Value |
|---------|-------|
| Name | `buzzboard-cluster` |
| Infrastructure | AWS Fargate |

### Step 7.4: Create Task Definitions

**ECS → Task Definitions → Create new task definition**

**Reactions Task**

| Setting | Value |
|---------|-------|
| Family | `buzzboard-reactions` |
| Launch type | Fargate |
| OS/Arch | Linux/x86_64 |
| CPU | 0.5 vCPU |
| Memory | 1 GB |
| Task role | `buzzboard-ecs-task-role` |
| Execution role | `buzzboard-ecs-execution-role` |

Container definition:
- Image: `YOUR_ACCOUNT.dkr.ecr.eu-central-1.amazonaws.com/buzzboard-reactions:latest`
- Port: 8081
- Environment vars:
  - `MYSQL_HOST`: `buzzboard-mysql.xxxx.rds.amazonaws.com`
  - `MYSQL_USER`: `buzzboard`
  - `MYSQL_DATABASE`: `buzzboard`
  - `REDIS_HOST`: `buzzboard-redis.xxxx.cache.amazonaws.com`
  - `PORT`: `8081`
- Secrets (from Secrets Manager):
  - `MYSQL_PASSWORD`: `arn:aws:secretsmanager:...:buzzboard/mysql:MYSQL_PASSWORD::`
  - `REDIS_PASSWORD`: `arn:aws:secretsmanager:...:buzzboard/redis:REDIS_PASSWORD::`
  - `JWT_SECRET`: `arn:aws:secretsmanager:...:buzzboard/app:JWT_SECRET::`
- Logging:
  - Log driver: `awslogs`
  - Log group: `/ecs/buzzboard-reactions` (create if needed)
  - Region: `eu-central-1`
  - Stream prefix: `ecs`

Repeat for **mood** task (port 8082, log group `/ecs/buzzboard-mood`).

### Step 7.5: Create ECS Services

**ECS → Clusters → buzzboard-cluster → Services → Create**

**Reactions Service**

| Setting | Value |
|---------|-------|
| Launch type | Fargate |
| Task definition | `buzzboard-reactions` |
| Desired count | 1 |
| Subnets | `compute-subnet-a` (optional: also `compute-subnet-b` for HA) |
| Security group | `buzzboard-ecs-tasks-sg` |
| Public IP | OFF |
| Load balancer | `buzzboard-internal-alb` |
| Container: Port | 8081 |
| Target group | `reactions-tg` |

Repeat for **mood** and **frontend** services.

### Step 7.6: ALB Listener Rules

**EC2 → Load Balancers → buzzboard-internal-alb → Listeners → HTTP:80 → Edit Rules**

Add rules in order:

1. **Priority 9:** Path `/auth/*` → Forward to `reactions-tg`
2. **Priority 10:** Path `/reactions*` → Forward to `reactions-tg`
3. **Priority 11:** Path `/mood*` → Forward to `mood-tg`
4. **Default:** Forward to `frontend-tg`

---

## Phase 8: API Gateway & VPC Link

### Step 8.1: Create VPC Link

**API Gateway → VPC Links → Create**

| Setting | Value |
|---------|-------|
| Name | `buzzboard-vpclink` |
| Subnets | `compute-subnet-a`, `compute-subnet-b` |
| Security group | `buzzboard-vpclink-sg` |

Wait for status `Available`.

### Step 8.2: Create HTTP API

**API Gateway → Create API → HTTP API**

| Setting | Value |
|---------|-------|
| Name | `buzzboard-api` |

Add integration:
- Route: `ANY /` , `/{proxy+}` , `/auth/{proxy+}`
- Integration type: Private resource
- Target: VPC Link → `buzzboard-vpclink` → ALB URI: `http://buzzboard-internal-alb-xxxx.eu-central-1.elb.amazonaws.com`

Deploy automatically to `$default` stage.

**Save the API endpoint:** `https://xxxx.execute-api.eu-central-1.amazonaws.com`

---

## Phase 9: Frontend Configuration

### Step 9.1: Update Frontend Config

Edit `frontend/public/config.docker.js`:

```javascript
const CONFIG = {
  REACTIONS_API_URL: "https://YOUR_API_GATEWAY_URL.execute-api.eu-central-1.amazonaws.com",
  MOOD_API_URL: "https://YOUR_API_GATEWAY_URL.execute-api.eu-central-1.amazonaws.com"
};
```

### Step 9.2: Build & Push Frontend

```bash
cd frontend
docker build --platform linux/amd64 -t buzzboard-frontend .
docker tag buzzboard-frontend:latest \
  $ACCOUNT_ID.dkr.ecr.$REGION.amazonaws.com/buzzboard-frontend:latest
docker push $ACCOUNT_ID.dkr.ecr.$REGION.amazonaws.com/buzzboard-frontend:latest
```

Then create ECS service (as in Phase 7).

---

## Phase 10: Monitoring

### Step 10.1: Create SNS Topic

**SNS → Topics → Create Topic**

- Name: `buzzboard-alerts`
- Create subscription: Email to your address
- Confirm email

### Step 10.2: Create CloudWatch Alarms

**CloudWatch → Alarms → Create Alarm**

Suggested alarms:

| Metric | Threshold | Action |
|--------|-----------|--------|
| ECS CPUUtilization (reactions) | > 75% for 5 min | SNS: `buzzboard-alerts` |
| ECS CPUUtilization (mood) | > 75% for 5 min | SNS: `buzzboard-alerts` |
| RDS CPUUtilization | > 75% for 5 min | SNS: `buzzboard-alerts` |
| ElastiCache CPUUtilization | > 75% for 5 min | SNS: `buzzboard-alerts` |

---

## Testing

Open the API Gateway URL in your browser and:

1. Sign up for an account
2. Post a reaction → Check it appears
3. Reload page → Reaction loads from cache (watch for "Source: Redis")
4. Post a mood → Check aggregation
5. Check CloudWatch logs: `tail -f /ecs/buzzboard-reactions`
6. Check ECS tasks: all should be `RUNNING`

---

## Troubleshooting

See [TROUBLESHOOTING.md](TROUBLESHOOTING.md) for common errors and solutions.

---

## Cleanup

To avoid ongoing charges:

```bash
# Scale down services
aws ecs update-service --cluster buzzboard-cluster --service reactions-service --desired-count 0
aws ecs update-service --cluster buzzboard-cluster --service mood-service --desired-count 0
aws ecs update-service --cluster buzzboard-cluster --service frontend-service --desired-count 0

# Delete services, cluster, ALB, RDS, ElastiCache, VPC Endpoints, VPC
# See full cleanup script in /scripts/cleanup.sh
```

---

## Cost Summary (24 hours)

| Service | Cost |
|---------|------|
| ECS Fargate (3 tasks) | $1.62 |
| Internal ALB | $0.54 |
| RDS MySQL (free tier) | $0.41 |
| ElastiCache Redis (free tier) | $0.82 |
| VPC Endpoints (4x) | $0.96 |
| **Total** | **~$4.35** |

With free tier: **potentially $0**
