FROM apify/actor-node:18

COPY package*.json ./
RUN npm install --omit=dev --omit=optional \
    && npm cache clean --force \
    && rm -rf /tmp/*

COPY . ./
