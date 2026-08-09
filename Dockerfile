FROM node:22-alpine

WORKDIR /app

COPY package.json package-lock.json ./
RUN npm ci --omit=dev --no-audit --no-fund \
    && npm cache clean --force

COPY scripts ./scripts

ENV NODE_ENV=production \
    STATE_FILE=/data/state.json \
    CHECK_INTERVAL_SECONDS=300

USER node

HEALTHCHECK --interval=60s --timeout=5s --start-period=90s --retries=3 \
  CMD node -e "const fs=require('fs');const s=JSON.parse(fs.readFileSync(process.env.STATE_FILE,'utf8'));if(Date.now()-Date.parse(s.checkedAt)>15*60*1000)process.exit(1)"

CMD ["node", "scripts/watch.mjs"]
