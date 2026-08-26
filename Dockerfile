# syntax=docker/dockerfile:1

# The image serves the HTTP transport. stdio is for clients that spawn the process
# themselves, which is precisely what a container does not do.

FROM node:24-slim AS build
WORKDIR /app

# --ignore-scripts matters here: the `prepare` script builds the project, and it would run
# on `npm ci` before any source has been copied. The build is invoked explicitly below.
COPY package.json package-lock.json ./
RUN npm ci --ignore-scripts

COPY tsconfig.json ./
COPY spec ./spec
COPY scripts ./scripts
COPY src ./src
RUN npm run build

FROM node:24-slim AS runtime

LABEL org.opencontainers.image.source="https://github.com/JigSawFr/eurodns-mcp"
LABEL org.opencontainers.image.description="Model Context Protocol server for the EuroDNS User API"
LABEL org.opencontainers.image.licenses="MIT"

ENV NODE_ENV=production \
    HOST=0.0.0.0 \
    PORT=3000

WORKDIR /app

# Without --ignore-scripts, `prepare` would try to build with no devDependencies present.
COPY package.json package-lock.json ./
RUN npm ci --omit=dev --ignore-scripts && npm cache clean --force

COPY --from=build /app/dist ./dist

# The audit log lives here. A named volume inherits this ownership; a bind mount does not,
# so a host directory has to be made writable by uid 1000 before it is mounted.
RUN mkdir -p /data && chown node:node /data
VOLUME ["/data"]

USER node
EXPOSE 3000

# node:22-slim ships no curl, and Node 22 has fetch built in.
HEALTHCHECK --interval=30s --timeout=3s --start-period=5s --retries=3 \
    CMD node -e "fetch('http://127.0.0.1:'+(process.env.PORT||3000)+'/healthz').then(r=>process.exit(r.ok?0:1)).catch(()=>process.exit(1))"

CMD ["node", "dist/http.js"]
