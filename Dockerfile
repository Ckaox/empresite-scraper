FROM apify/actor-node-playwright-chrome:20

COPY package*.json ./
RUN npm install --omit=dev --omit=optional \
    && echo "Packages installed."

COPY . ./

CMD npm start
