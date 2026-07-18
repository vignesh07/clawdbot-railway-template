# K8s Deployment Manifests (Hetzner / Epyc cluster)

Synced from live deployment on 2026-07-18.

## Files

- `deployment.yaml` — Full K8s manifest (namespace, deployment, services, ingress)
- `openclaw.json` — Gateway config (sanitized — secrets/redacted tokens removed)

## Deploy

```bash
kubectl apply -f k8s/deployment.yaml
```

## Live State (as of 2026-07-18)

- Pod: `openclaw-64cb8966cc-ft95b` — 2/2 Running
- OpenClaw binary: `2026.4.12`
- Image: `localhost:32000/openclaw:latest`
- DefenseClaw: `localhost:32000/involving-ai/defenseclaw-gateway:0.6.6-ext2`
- Namespace: `openclaw` (created 156d ago)
- Deployment revision: 29, generation: 32
- Last restart: 2026-07-15T19:20:16-04:00