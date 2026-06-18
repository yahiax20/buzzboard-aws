# Troubleshooting Guide

Common errors encountered during deployment and how to fix them.

## ECS & Container Issues

### Error: CannotPullContainerError

**Symptoms:**
```
CannotPullContainerError: failed to pull image "xxx.dkr.ecr.eu-central-1.amazonaws.com/buzzboard-reactions:latest"
failed to resolve reference ... net/http: request canceled
```

**Root cause:** ECS tasks in private subnets can't reach ECR. Missing or misconfigured VPC Endpoints.

**Solution:**

1. Verify VPC Endpoints exist:
   - VPC → Endpoints → check for `vpce-ecr-api`, `vpce-ecr-dkr`, `vpce-s3`
   
2. Verify endpoints are in compute subnets:
   - Each endpoint should list `compute-subnet-a`, `compute-subnet-b`
   
3. Verify security group allows traffic:
   - VPC Endpoints should have inbound HTTPS 443 from `buzzboard-ecs-tasks-sg`
   - Route table should have S3 gateway endpoint attached

4. If endpoints are missing, create them (see DEPLOYMENT.md Phase 5)

5. Restart ECS tasks:
   ```bash
   aws ecs update-service --cluster buzzboard-cluster --service reactions-service --force-new-deployment
   ```

---

### Error: Essential container in task exited

**Symptoms:**
```
ECS task status: STOPPED
Reason: Essential container in task exited
```

**Root causes:** 
1. Missing environment variable
2. Wrong secret ARN syntax
3. Application crash (check logs)

**Solution:**

1. Check task definition environment variables:
   - ECS → Task Definitions → `buzzboard-reactions:1` → Check all vars are set
   - Ensure `PORT=8081` (for reactions) is a plain environment variable
   
2. Check secrets syntax:
   - Secret references must end with `::` 
   - ✅ Correct: `arn:aws:secretsmanager:...:secret:buzzboard/mysql:MYSQL_PASSWORD::`
   - ❌ Wrong: `arn:aws:secretsmanager:...:secret:buzzboard/mysql`

3. Check application logs:
   ```bash
   aws logs tail /ecs/buzzboard-reactions --follow --region eu-central-1
   ```

4. If logs show missing variable, restart task:
   ```bash
   aws ecs update-service --cluster buzzboard-cluster --service reactions-service --force-new-deployment
   ```

---

### Error: Exec format error when container starts

**Symptoms:**
Container immediately stops with `exit code 1`.

**Root cause:** Built Docker image on ARM (Mac M1) but ECS runs x86_64.

**Solution:**

1. Rebuild with platform flag:
   ```bash
   docker build --platform linux/amd64 -t buzzboard-reactions .
   ```

2. Push updated image:
   ```bash
   docker tag buzzboard-reactions:latest $ACCOUNT.dkr.ecr.eu-central-1.amazonaws.com/buzzboard-reactions:latest
   docker push $ACCOUNT.dkr.ecr.eu-central-1.amazonaws.com/buzzboard-reactions:latest
   ```

3. Force ECS to use new image:
   ```bash
   aws ecs update-service --cluster buzzboard-cluster --service reactions-service --force-new-deployment
   ```

---

## Database Connectivity Issues

### Error: MYSQL_HOST resolves to JSON object

**Symptoms:**
```
getaddrinfo ENOTFOUND {"MYSQL_HOST":"buzzboard-mysql..."}
```

**Root cause:** Secrets Manager extraction using full JSON instead of extracting key.

**Solution:**

Task definition secret reference must use `::` suffix to extract specific key:
- ✅ Correct: `arn:aws:secretsmanager:eu-central-1:ACCOUNT:secret:buzzboard/mysql:MYSQL_PASSWORD::`
- ❌ Wrong: `arn:aws:secretsmanager:eu-central-1:ACCOUNT:secret:buzzboard/mysql`

The `::` at the end tells ECS to extract just the `MYSQL_PASSWORD` key, not the entire JSON.

Update task definition and redeploy.

---

### Error: RDS connection timeout (30 seconds)

**Symptoms:**
```
ER_HANDSHAKE_INACTIVITY_TIMEOUT
Can't connect to MySQL server on 'buzzboard-mysql...'
```

**Root cause:** Security group `buzzboard-rds-sg` doesn't allow traffic from ECS.

**Solution:**

1. EC2 → Security Groups → select `buzzboard-rds-sg`
2. Inbound Rules → Add rule:
   - Type: MySQL/Aurora
   - Port: 3306
   - Source: `buzzboard-ecs-tasks-sg` (select from dropdown)
3. Save rules
4. Wait 30 seconds for propagation
5. Restart ECS tasks:
   ```bash
   aws ecs update-service --cluster buzzboard-cluster --service reactions-service --force-new-deployment
   ```

---

### Error: Redis connection refused

**Symptoms:**
```
ECONNREFUSED ... 6379
Error: Redis connection refused: connect ECONNREFUSED 127.0.0.1:6379
```

**Root causes:**
1. Wrong endpoint (using node endpoint instead of primary)
2. Password mismatch
3. Security group doesn't allow traffic
4. In-transit encryption enabled but app doesn't know

**Solution:**

1. Verify Redis endpoint in task definition:
   - Should be **Primary Endpoint**, NOT node endpoint
   - Format: `buzzboard-redis.xxxx.cache.amazonaws.com`

2. Verify password matches:
   - Secrets Manager → `buzzboard/redis` → check `REDIS_PASSWORD`
   - Should match the auth token set during Redis cluster creation

3. Verify security group:
   - EC2 → Security Groups → `buzzboard-redis-sg`
   - Inbound rule: TCP 6379 from `buzzboard-ecs-tasks-sg`

4. Check if your Node.js Redis client needs TLS config:
   - If `In-transit encryption: Enabled` in Redis cluster, app might need `tls: true`

---

## Load Balancing Issues

### Error: API Gateway returns 503 Service Unavailable

**Symptoms:**
```
HTTP 503 Service Unavailable
UpstreamServiceException: The upstream server is temporarily disabled
```

**Root cause:** VPC Link security group has no outbound rule to ALB.

**Solution:**

1. EC2 → Security Groups → select `buzzboard-vpclink-sg`
2. Outbound Rules → Add rule:
   - Type: HTTP
   - Port: 80
   - Destination: `buzzboard-alb-sg`
3. Save
4. Test API Gateway URL again:
   ```bash
   curl https://YOUR_API_GATEWAY_URL.execute-api.eu-central-1.amazonaws.com/
   ```

---

### Error: ALB target group shows "Unhealthy"

**Symptoms:**
```
Target: Unhealthy
Health check failed with these codes: [404, 502, 503]
```

**Root causes:**
1. Health check path doesn't exist in app
2. App is not listening on correct port
3. Security group blocks traffic from ALB

**Solution:**

1. Check health check path:
   - EC2 → Target Groups → select target group
   - Health check protocol: HTTP
   - Health check path: `/` or `/health` (must exist in your app)
   - Verify your Node.js app responds to this path

2. Verify port matches app:
   - Task definition should have port 8081 for reactions, 8082 for mood

3. Verify security group:
   - `buzzboard-ecs-tasks-sg` should allow TCP 8081/8082 from `buzzboard-alb-sg`

4. Check app logs:
   ```bash
   aws logs tail /ecs/buzzboard-reactions --follow
   ```

---

### Error: ALB listener rule doesn't route correctly

**Symptoms:**
```
404 Not Found
or wrong service responds
```

**Root cause:** ALB listener rules don't match your backend routes.

**Solution:**

1. Check what routes your backend actually uses:
   - Open `backend/reactions/server.js` → look for `app.get('...')` patterns
   - If using `/api/reactions`, ALB rule should be `/api/reactions*`
   - If using `/reactions`, ALB rule should be `/reactions*`

2. EC2 → Load Balancers → select ALB → Listeners → HTTP:80 → Edit Rules

3. Update path patterns to match your routes:
   - Path `/auth/*` → reactions-tg (authentication routes)
   - Path `/reactions*` → reactions-tg (reactions API)
   - Path `/mood*` → mood-tg (mood API)
   - Default → frontend-tg (static HTML)

---

## Networking Issues

### Error: VPC Link creation fails with "subnets must be private"

**Symptoms:**
```
Error creating VPC Link: subnets must be private
```

**Root cause:** Selected public subnets instead of private subnets.

**Solution:**

1. Delete the failed VPC Link
2. API Gateway → VPC Links → Create again
3. **Select only private compute subnets:**
   - `compute-subnet-a` (10.0.1.0/24)
   - `compute-subnet-b` (10.0.2.0/24)
4. Security group: `buzzboard-vpclink-sg`

---

### Error: Private subnets have no internet access

**Symptoms:**
```
Error accessing AWS services
Task can't reach ECR, CloudWatch, Secrets Manager
```

**Root cause:** No route to AWS services (VPC Endpoints not configured).

**Solution:**

Create VPC Endpoints (see DEPLOYMENT.md Phase 5):
- Interface endpoints for ECR, CloudWatch Logs, Secrets Manager
- Gateway endpoint for S3
- Attach security group `buzzboard-endpoints-sg`

Verify endpoints are `Available` before deploying ECS tasks.

---

## Application Issues

### Error: Frontend can't call backend API

**Symptoms:**
```
Reactions API returns 404
CORS errors in browser console
or request times out
```

**Root causes:**
1. Frontend config has wrong API Gateway URL
2. API Gateway integration misconfigured
3. ALB listener rules don't route the request

**Solution:**

1. Check frontend config:
   - `frontend/public/config.docker.js` must have correct API Gateway URL
   - URL must be HTTPS and include `.execute-api.`
   - Example: `https://44vwym347k.execute-api.eu-central-1.amazonaws.com`

2. Rebuild and push frontend:
   ```bash
   docker build --platform linux/amd64 -t buzzboard-frontend .
   docker push $ACCOUNT.dkr.ecr.eu-central-1.amazonaws.com/buzzboard-frontend:latest
   ```

3. Update ECS service with new image:
   ```bash
   aws ecs update-service --cluster buzzboard-cluster --service frontend-service --force-new-deployment
   ```

4. Check ALB listener rules match your API routes:
   - If backend uses `/api/reactions`, rule should be `/api/reactions*`

---

### Error: Reactions not being cached

**Symptoms:**
```
All loads show "Source: MySQL"
Never shows "Source: Redis"
```

**Root cause:** Redis connection failed silently, app fell back to MySQL.

**Solution:**

1. Check Redis endpoint in task definition (must be primary, not node)
2. Check Redis password is correct
3. Check Redis security group allows traffic from ECS
4. Verify in-transit encryption setting:
   - If enabled, app might need TLS config in Redis client
5. Check logs for Redis errors:
   ```bash
   aws logs tail /ecs/buzzboard-reactions --follow
   ```

---

## CloudWatch & Monitoring Issues

### Error: CloudWatch logs are empty

**Symptoms:**
```
ECS tasks running but /ecs/buzzboard-reactions shows no logs
```

**Root cause:** Task definition missing CloudWatch Logs configuration.

**Solution:**

1. ECS → Task Definitions → select `buzzboard-reactions`
2. Create new revision
3. Container: scroll to Logging
4. Log driver: `awslogs`
5. Log group: `/ecs/buzzboard-reactions` (create manually if needed)
6. Log stream prefix: `ecs`
7. Create and deploy new task

---

### Error: Alarms firing constantly

**Symptoms:**
```
Email every 5 minutes
CPU alarm triggers even when app idle
```

**Root cause:** Alarm threshold too aggressive for workload.

**Solution:**

1. Check actual metrics:
   - CloudWatch → Metrics → ECS → select service
   - Look at actual CPU usage

2. If false positive, increase threshold:
   - CloudWatch → Alarms → edit alarm
   - Change threshold to 85% or 90% instead of 75%

3. If actual high CPU:
   - Check app logs for infinite loops or memory leaks
   - May need to increase task CPU/memory

---

## Final Debugging Steps

**If stuck, try in order:**

1. **Check logs:**
   ```bash
   aws logs tail /ecs/buzzboard-reactions --follow --region eu-central-1
   aws logs tail /ecs/buzzboard-mood --follow --region eu-central-1
   aws logs tail /ecs/buzzboard-frontend --follow --region eu-central-1
   ```

2. **Verify connectivity to databases:**
   ```bash
   # From a task's shell:
   aws ecs execute-command --cluster buzzboard-cluster --task <task-id> --interactive --command "/bin/sh"
   # Then try: nc -zv buzzboard-mysql.xxxx.rds.amazonaws.com 3306
   ```

3. **Check all security groups:**
   - Every ingress must have a source
   - Every outbound must allow to destination

4. **Restart ECS service:**
   ```bash
   aws ecs update-service --cluster buzzboard-cluster --service reactions-service --force-new-deployment
   ```

5. **Check task definition:**
   - All environment variables set?
   - All secrets with correct ARN syntax (ending in `::`)?
   - Logging driver configured?

6. **Verify URLs are correct:**
   - RDS endpoint
   - Redis primary endpoint
   - API Gateway URL

---

**Still stuck?** Check [DEPLOYMENT.md](DEPLOYMENT.md) Phase-by-phase to ensure no step was missed.
