# syntax=docker/dockerfile:1

# Build on Debian 12 (glibc 2.36). The runtime must be the same Debian release
# so native modules compiled here (e.g. bcrypt in U5) load at runtime.
# node:24-slim is bookworm, so the matching distroless tag is nodejs24-debian12.
FROM node:24-slim AS build
WORKDIR /app
COPY package.json package-lock.json ./
RUN npm ci
COPY tsconfig.json tsconfig.build.json ./
COPY src ./src
RUN npm run build

FROM node:24-slim AS prod-deps
WORKDIR /app
COPY package.json package-lock.json ./
RUN npm ci --omit=dev && npm cache clean --force

# Distroless: no shell, no npm. ENTRYPOINT is ["/nodejs/bin/node"], so CMD is
# just the script. The :nonroot variant runs as uid 65532.
FROM gcr.io/distroless/nodejs24-debian12:nonroot AS runtime
ENV NODE_ENV=production
WORKDIR /app
COPY --from=prod-deps /app/node_modules ./node_modules
COPY --from=build /app/dist ./dist
COPY package.json healthcheck.js ./
EXPOSE 3000
HEALTHCHECK --interval=10s --timeout=3s --start-period=10s --retries=3 \
  CMD ["/nodejs/bin/node", "healthcheck.js"]
CMD ["dist/main.js"]
