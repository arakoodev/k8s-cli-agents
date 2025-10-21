FROM node:20-alpine

# Create non-root user
RUN addgroup -g 1001 runner && \
    adduser -D -u 1001 -G runner runner

# Install dependencies
RUN apk add --no-cache bash curl git unzip tar ttyd

# Create working directory with proper permissions
WORKDIR /work
RUN chown runner:runner /work

# Copy entrypoint and set permissions
COPY --chown=runner:runner entrypoint.sh /entrypoint.sh
RUN chmod +x /entrypoint.sh

# Switch to non-root user
USER runner

ENTRYPOINT ["/entrypoint.sh"]
