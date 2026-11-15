# Image avec Node + Python (Leboncoin actif). Données persistantes dans /app/data.
FROM node:22-slim
RUN apt-get update && apt-get install -y --no-install-recommends python3 python3-pip && rm -rf /var/lib/apt/lists/*
WORKDIR /app
COPY requirements.txt ./
RUN pip install --no-cache-dir --break-system-packages -r requirements.txt
COPY package*.json ./
RUN npm ci --omit=dev
COPY . .
VOLUME /app/data
USER node
CMD ["node", "index.js"]
