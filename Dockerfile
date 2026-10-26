# ---- build stage -----------------------------------------------------------
FROM node:24-alpine AS build

WORKDIR /app

COPY package.json package-lock.json ./
RUN npm ci --no-audit --no-fund

COPY scripts ./scripts
COPY public ./public
COPY src ./src

RUN npm run build

# ---- runtime stage ---------------------------------------------------------
FROM node:24-alpine

WORKDIR /app

ENV NODE_ENV=production
ENV PORT=8080

COPY --from=build /app/package.json ./package.json
COPY --from=build /app/node_modules ./node_modules
COPY --from=build /app/public ./public
COPY --from=build /app/src ./src

USER node

EXPOSE 8080

HEALTHCHECK --interval=30s --timeout=5s --start-period=10s --retries=3 \
	CMD node -e "fetch('http://127.0.0.1:8080/healthz').then(r=>process.exit(r.ok?0:1)).catch(()=>process.exit(1))"

CMD ["node", "src/index.js"]
