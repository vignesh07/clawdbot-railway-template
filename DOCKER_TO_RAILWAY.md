# Migrating from Docker to Railway

This guide helps you migrate an existing Docker or Docker Compose deployment to Railway using this template.

## Why Migrate to Railway?

### Advantages of Railway vs Self-hosted Docker

| Feature | Docker (Self-hosted) | Railway |
|---------|---------------------|---------|
| **Setup Time** | Hours (server setup, docker install, networking) | Minutes (one-click deploy) |
| **SSL/HTTPS** | Manual (certbot, nginx config) | Automatic |
| **Monitoring** | Manual (install monitoring tools) | Built-in dashboard |
| **Logging** | Manual (configure log aggregation) | Built-in log viewer |
| **Deployments** | Manual (pull, rebuild, restart) | Git push or one-click |
| **Scaling** | Manual (orchestration tools) | Automatic |
| **Cost** | VPS ($5-20/mo) + time | $3-6/mo + no maintenance |
| **Backups** | Manual scripting | Built-in volume snapshots |
| **Uptime** | Your responsibility | 99.9% SLA |

## Prerequisites

Before migrating, ensure you have:

1. **Railway account** - [Sign up here](https://railway.app)
2. **Backup of current data** - Export from your current setup
3. **Bot tokens** - Keep your existing tokens handy
4. **Configuration** - Note any custom settings

## Migration Paths

Choose the path that matches your current setup:

### Path A: Direct Docker Migration

If you're running Docker directly with `docker run`:

```bash
# Your current setup (example)
docker run -d \
  -p 8080:8080 \
  -e SETUP_PASSWORD=mysecret \
  -v /opt/openclaw:/data \
  openclaw:latest
```

**Migration steps:**

1. **Export your data:**
   ```bash
   # Create a backup of your volume
   docker run --rm \
     -v /opt/openclaw:/data \
     -v $(pwd):/backup \
     alpine tar czf /backup/openclaw-backup.tar.gz -C /data .
   ```

2. **Deploy to Railway:**
   - Click the Deploy button in this repository
   - Add a Volume mounted at `/data`
   - Set `SETUP_PASSWORD` environment variable

3. **Restore your data:**
   - Go to `https://your-app.up.railway.app/setup`
   - Use the Import Backup feature
   - Upload your `openclaw-backup.tar.gz`

4. **Verify:**
   - Check that all bots are connected
   - Test functionality
   - Update DNS if using custom domain

### Path B: Docker Compose Migration

If you're using docker-compose.yml:

```yaml
# Your current docker-compose.yml
version: '3.8'
services:
  openclaw:
    image: openclaw:latest
    ports:
      - "8080:8080"
    volumes:
      - ./data:/data
    environment:
      - SETUP_PASSWORD=mysecret
      - OPENCLAW_STATE_DIR=/data/.openclaw
```

**Migration steps:**

1. **Backup your data:**
   ```bash
   # Stop containers
   docker-compose down
   
   # Create backup
   tar czf openclaw-backup.tar.gz ./data
   ```

2. **Deploy to Railway:**
   - Use this repository as template
   - Configure Volume and environment variables
   - Deploy

3. **Restore configuration:**
   - Import backup via `/setup` interface
   - Or manually set up via setup wizard

4. **Update your DNS:**
   - Point your domain to Railway's assigned URL
   - Or use Railway's custom domain feature

### Path C: Kubernetes/Cloud Migration

If you're running on Kubernetes or cloud platforms:

1. **Export your persistent volumes:**
   ```bash
   kubectl exec <pod-name> -- tar czf - /data > openclaw-backup.tar.gz
   ```

2. **Deploy to Railway** (same as above)

3. **Import data** via `/setup` interface

4. **Decommission old infrastructure:**
   - Scale down old deployment
   - Delete resources after verification

## Step-by-Step Migration Guide

### Step 1: Prepare Your Current Setup

1. **Document current configuration:**
   ```bash
   # List environment variables
   docker inspect <container-id> | grep Env
   
   # Note mounted volumes
   docker inspect <container-id> | grep Mounts
   ```

2. **Create a complete backup:**
   ```bash
   # Stop the container to ensure consistency
   docker stop <container-id>
   
   # Backup the data directory
   docker run --rm \
     --volumes-from <container-id> \
     -v $(pwd):/backup \
     alpine tar czf /backup/openclaw-$(date +%Y%m%d).tar.gz -C /data .
   
   # Restart container if needed
   docker start <container-id>
   ```

3. **Save your configuration:**
   - Bot tokens
   - Authentication settings
   - Custom domains
   - API keys

### Step 2: Deploy to Railway

1. **Create Railway project:**
   - Go to [Railway](https://railway.app)
   - Click "Deploy on Railway" button from this repository
   - Or create new project from GitHub

2. **Configure Volume:**
   - In Railway project settings
   - Create new Volume
   - Mount path: `/data`
   - Size: 1GB (or based on your current usage)

3. **Set environment variables:**
   
   **Required:**
   ```
   SETUP_PASSWORD=<choose-strong-password>
   ```
   
   **Recommended:**
   ```
   OPENCLAW_STATE_DIR=/data/.openclaw
   OPENCLAW_WORKSPACE_DIR=/data/workspace
   ```
   
   **Optional (if you want to preserve token):**
   ```
   OPENCLAW_GATEWAY_TOKEN=<your-existing-token>
   ```

4. **Enable public networking:**
   - In project settings, enable "Public Domain"
   - Note the assigned URL: `https://your-app.up.railway.app`

5. **Deploy:**
   - Click "Deploy"
   - Wait for build to complete (~5-10 minutes)
   - Check logs for any errors

### Step 3: Migrate Your Data

**Option A: Use Import Feature (Recommended)**

1. Go to `https://your-app.up.railway.app/setup`
2. Enter your `SETUP_PASSWORD`
3. Scroll to "Import Backup"
4. Upload your `.tar.gz` backup file
5. Click "Import"
6. Wait for import and restart

**Option B: Fresh Setup**

If you prefer to start fresh:

1. Go to `/setup`
2. Run the setup wizard
3. Re-enter your bot tokens
4. Configure authentication
5. Re-add channels

### Step 4: Verify Migration

1. **Check gateway status:**
   - Visit `https://your-app.up.railway.app/`
   - Login with your credentials
   - Verify gateway is running

2. **Test bots:**
   - Send test message to Telegram bot
   - Send test message to Discord bot
   - Verify responses work

3. **Check Control UI:**
   - Visit `https://your-app.up.railway.app/openclaw`
   - Verify all features work

4. **Monitor logs:**
   - Check Railway dashboard logs
   - Look for any errors or warnings

### Step 5: Update Integrations

1. **Update bot webhooks** (if using webhooks):
   - Telegram: Update webhook URL
   - Discord: Update interaction URL
   - Slack: Update event subscription URL

2. **Update custom domains:**
   - Add custom domain in Railway
   - Update DNS records
   - Wait for SSL provisioning

3. **Update monitoring** (if applicable):
   - Update uptime monitoring URLs
   - Configure Railway notifications

### Step 6: Decommission Old Setup

**⚠️ Only after verifying everything works!**

1. **Keep old setup running for 24-48 hours** as backup
2. **Monitor Railway deployment** for issues
3. **Once stable, stop old containers:**
   ```bash
   docker stop <container-id>
   docker rm <container-id>
   ```
4. **Archive old data:**
   ```bash
   # Keep backup for 30 days
   mv openclaw-backup.tar.gz ~/archives/
   ```

## Environment Variable Mapping

Map your current Docker environment variables to Railway:

| Docker Variable | Railway Variable | Notes |
|----------------|------------------|-------|
| `PORT` | `PORT` | Railway may auto-set, but 8080 works |
| `SETUP_PASSWORD` | `SETUP_PASSWORD` | Required in Railway |
| Volume path | `OPENCLAW_STATE_DIR` | Set to `/data/.openclaw` |
| Volume path | `OPENCLAW_WORKSPACE_DIR` | Set to `/data/workspace` |
| `GATEWAY_TOKEN` | `OPENCLAW_GATEWAY_TOKEN` | Optional, auto-generated if not set |
| Custom config | Copy to Railway | Use Railway environment variables |

## Rollback Plan

If migration fails, here's how to rollback:

1. **Keep old Docker setup running** until verified
2. **Export from Railway:**
   - Go to `/setup`
   - Download backup
   - Keep for recovery

3. **Rollback to Docker:**
   ```bash
   # Restart old container
   docker start <container-id>
   
   # Or recreate from backup
   docker run -d \
     -p 8080:8080 \
     -v /opt/openclaw:/data \
     -e SETUP_PASSWORD=mysecret \
     openclaw:latest
   
   # Restore data
   docker run --rm \
     -v /opt/openclaw:/data \
     -v $(pwd):/backup \
     alpine tar xzf /backup/openclaw-backup.tar.gz -C /data
   ```

## Common Migration Issues

### Issue: Import fails with "Invalid backup format"

**Solution:**
- Ensure backup is a `.tar.gz` file
- Verify backup contains `/.openclaw` directory
- Try creating backup again with correct paths

### Issue: Bot tokens not working

**Solution:**
- Re-enter tokens via `/setup` interface
- Check tokens are still valid
- Verify bot permissions haven't changed

### Issue: Custom domain not working

**Solution:**
- Wait for DNS propagation (up to 24 hours)
- Verify DNS records are correct
- Check Railway custom domain settings

### Issue: Files missing after migration

**Solution:**
- Check backup includes all files
- Verify volume mount path is `/data`
- Re-import backup if needed

### Issue: High memory usage

**Solution:**
- Railway default is 512MB, may need to increase
- Check for memory leaks in logs
- Restart service if needed

## Cost Comparison

### Self-hosted Docker (Monthly)

- VPS (2GB RAM): $10-20
- Domain: $1
- SSL certificate: $0 (Let's Encrypt)
- Backup storage: $2-5
- **Total: $13-26/month**
- **Time: 5-10 hours/month maintenance**

### Railway (Monthly)

- Compute (512MB): $3-5
- Volume (1GB): $0.25
- **Total: $3-6/month**
- **Time: 0 hours maintenance**

### Break-even Analysis

Even if Railway costs slightly more, the time saved (5-10 hours/month) makes it cost-effective for most users.

## Post-Migration Checklist

- [ ] Gateway is accessible at Railway URL
- [ ] All bots are responding correctly
- [ ] Control UI works properly
- [ ] Backup/export function works
- [ ] Custom domain configured (if applicable)
- [ ] Monitoring alerts set up
- [ ] Old Docker setup decommissioned
- [ ] Documentation updated with new URLs
- [ ] Team members notified of new URLs
- [ ] Backup schedule configured

## Support

If you encounter issues during migration:

1. **Check logs:** Railway dashboard → Your project → Deployments → View logs
2. **Review docs:** See [RAILWAY_DEPLOYMENT.md](./RAILWAY_DEPLOYMENT.md)
3. **GitHub Issues:** Open an issue in this repository
4. **Railway Discord:** Get help from Railway community
5. **OpenClaw Discord:** Get help from OpenClaw community

## FAQ

**Q: Can I migrate back to Docker later?**
A: Yes! Use the export feature to download your data, then deploy with Docker using the same Dockerfile.

**Q: Will my bot tokens need to change?**
A: No, bot tokens remain the same. Only the deployment infrastructure changes.

**Q: What happens to my data during migration?**
A: Your data is safely stored in Railway Volumes. Always keep backups during migration.

**Q: Can I test Railway before fully migrating?**
A: Yes! Deploy to Railway with new bot tokens, test thoroughly, then migrate production setup.

**Q: Is Railway more reliable than self-hosting?**
A: Railway provides 99.9% uptime SLA and automatic failover, typically more reliable than single-server setups.

**Q: Can I use custom domains?**
A: Yes! Railway supports custom domains with automatic SSL certificates.

---

**Ready to migrate?** Click the deploy button in the README to get started!
