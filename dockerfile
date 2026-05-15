# Stage 1: Build
FROM mirror.gcr.io/node:24-alpine AS builder

WORKDIR /app

# Copy package files from the local typescript example folder
# Note: Path is relative to the root of the conformance repo
COPY examples/servers/typescript/package*.json ./

# Install all dependencies (including devDependencies needed for tsx)
RUN npm ci

# Copy the rest of the server source code
COPY examples/servers/typescript/ ./

# Stage 2: Production Release
FROM mirror.gcr.io/node:24-alpine AS release

WORKDIR /app

# Copy only necessary built files and node_modules from builder stage
COPY --from=builder /app/ ./

# Set production environment variables
ENV NODE_ENV=production
ENV PORT=3000

# Document the port usage
EXPOSE 3000

# Execution command
CMD ["npm", "start"]