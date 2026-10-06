#!/bin/sh
# Arranque: si no hay perfil de navegador, se descarga el seed desde Vercel
set -e

if [ -n "$SEED_URL" ] && [ -n "$SEED_TOKEN" ] && [ ! -d /app/.auth/profile ]; then
    echo "[entrypoint] Descargando perfil seed desde $SEED_URL ..."
    mkdir -p /app/.auth
    if curl -fsSL --max-time 60 -H "x-seed-token: $SEED_TOKEN" "$SEED_URL" -o /tmp/profile-seed.tar.gz; then
        tar -xzf /tmp/profile-seed.tar.gz -C /app/.auth && rm -f /tmp/profile-seed.tar.gz
        echo "[entrypoint] Perfil extraído OK en /app/.auth/profile"
    else
        echo "[entrypoint] WARN: no se pudo descargar el perfil seed (el login podría pedir MFA)"
        rm -rf /app/.auth
    fi
fi

exec node server.js
