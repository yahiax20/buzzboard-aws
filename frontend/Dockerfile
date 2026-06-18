FROM nginx:alpine
# Build context must be frontend/ (directory containing public/)
COPY public/ /usr/share/nginx/html/
COPY public/config.docker.js /usr/share/nginx/html/config.js
RUN test -f /usr/share/nginx/html/index.html && test -s /usr/share/nginx/html/index.html || (echo "ERROR: index.html missing or empty - run build from project root: docker-compose build frontend" && exit 1)
RUN rm -f /etc/nginx/conf.d/default.conf
COPY nginx.conf /etc/nginx/conf.d/default.conf
EXPOSE 80
CMD ["nginx", "-g", "daemon off;"]
