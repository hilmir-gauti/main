# Rafræn Þjónusta — container image for a persistent host (Fly.io, Railway…).
#
# The application has no runtime dependencies, so the final image carries only
# the compiled JavaScript. Everything in node_modules is a build tool.
#
# It is deliberately a *single* long-lived process: the database is a SQLite
# file on a mounted volume and the background worker is an in-process timer.
# Run exactly one instance — see fly.toml.

FROM node:22-alpine AS build
WORKDIR /app

# Dependencies first so a source-only change reuses this layer.
COPY package.json package-lock.json ./
RUN npm ci

COPY tsconfig.json ./
COPY src ./src
RUN npm run build


FROM node:22-alpine
WORKDIR /app

# node:sqlite is behind a flag on Node 22 and the entry point does not set it
# for itself — the desktop build passes it on the command line.
ENV NODE_OPTIONS=--experimental-sqlite \
    NODE_ENV=production \
    PORT=8080 \
    HOST=0.0.0.0 \
    DATA_DIR=/data

COPY --from=build /app/dist ./dist
COPY package.json ./

# The volume is mounted over this, but the directory must exist for a run
# without one (a local `docker run` while trying the image out).
RUN mkdir -p /data && chown -R node:node /data
USER node

EXPOSE 8080

# Liveness is the platform's job, but an image that can answer for itself is
# easier to debug when the platform says only "unhealthy".
HEALTHCHECK --interval=30s --timeout=5s --start-period=15s --retries=3 \
  CMD node -e "fetch('http://127.0.0.1:8080/heilsa').then(r=>process.exit(r.ok?0:1)).catch(()=>process.exit(1))"

CMD ["node", "dist/index.js"]
