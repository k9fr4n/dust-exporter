# dust-exporter — OpenAI/Anthropic-compatible proxy in front of Dust agents.
# Runs the TypeScript sources directly via tsx (no build step).
FROM node:24-slim

WORKDIR /app

# Install deps first for better layer caching. The Dust SDK is a local tarball,
# so it must be present before `npm ci`. keytar (the system-keychain backend) is
# an optionalDependency and useless inside a container — omit it so we don't need
# libsecret / native build tools, and force the file credential backend below.
COPY package.json package-lock.json dust-tt-client-1.2.6.tgz ./
RUN npm ci --omit=optional

# Application sources (tsx reads the TS directly, guided by tsconfig.json).
COPY tsconfig.json ./
COPY src ./src

# Persist credentials and the conversation-state map on a volume.
RUN mkdir -p /data && chown -R node:node /data /app
USER node

ENV DUST_PROXY_HOST=0.0.0.0 \
    DUST_PROXY_PORT=8787 \
    DUST_CREDENTIAL_STORE=file \
    DUST_CREDENTIAL_FILE=/data/credentials.json \
    DUST_PROXY_STATE_FILE=/data/dust-exporter-state.json

VOLUME ["/data"]
EXPOSE 8787

# `serve` is the default; override with `login` / `status` / `logout`, e.g.
#   docker run -it --rm -v dust-data:/data dust-exporter login
ENTRYPOINT ["npx", "tsx", "src/index.ts"]
CMD ["serve"]

HEALTHCHECK --interval=30s --timeout=5s --start-period=10s --retries=3 \
    CMD node -e "fetch('http://127.0.0.1:'+(process.env.DUST_PROXY_PORT||8787)+'/health').then(r=>process.exit(r.ok?0:1)).catch(()=>process.exit(1))"
