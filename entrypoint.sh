#!/bin/sh
# Arranque: si no hay perfil de navegador, se descarga el seed desde Vercel
set -e

if [ -n "$SEED_URL" ] && [ -n "$SEED_TOKEN" ] && [ ! -d /app/.auth/profile ]; then
    echo "[entrypoint] Descargando perfil seed desde $SEED_URL ..."
    mkdir -p /app/.auth
    # node está garantizado en la imagen; curl/wget pueden no estarlo
    if node -e 'fetch(process.env.SEED_URL, { headers: { "x-seed-token": process.env.SEED_TOKEN } })
        .then(r => { if (!r.ok) throw new Error("HTTP " + r.status); return r.arrayBuffer(); })
        .then(b => require("node:fs").writeFileSync("/tmp/profile-seed.tar.gz", Buffer.from(b)))
        .catch(e => { console.error(e); process.exit(1); })' &&
        tar -xzf /tmp/profile-seed.tar.gz -C /app/.auth && rm -f /tmp/profile-seed.tar.gz; then
        echo "[entrypoint] Perfil extraído OK en /app/.auth/profile"
    else
        echo "[entrypoint] WARN: no se pudo descargar el perfil seed (el login podría pedir MFA)"
        rm -rf /app/.auth
    fi
fi

exec node server.js
