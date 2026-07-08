FROM apify/actor-node-playwright-chrome:18

USER root
COPY package*.json ./
RUN npm install --omit=dev --omit=optional \
    && npm cache clean --force \
    && rm -rf /tmp/*

COPY . ./
RUN chown -R myuser:myuser /home/myuser
USER myuser
