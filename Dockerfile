FROM apify/actor-node-playwright-chrome:20

USER root
COPY package*.json ./
ENV PLAYWRIGHT_SKIP_BROWSER_DOWNLOAD=1
RUN npm install --omit=dev --omit=optional \
    && npm cache clean --force \
    && rm -rf /tmp/*

COPY . ./
RUN chown -R myuser:myuser /home/myuser
USER myuser
