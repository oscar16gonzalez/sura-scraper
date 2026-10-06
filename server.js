const http = require('node:http');
const path = require('node:path');
const fs = require('node:fs');
const crypto = require('node:crypto');
const { ejecutarCotizacion, PDF_DIR } = require('./scraper');

const PORT = Number(process.env.PORT) || 3000;
const HOST = process.env.HOST || '127.0.0.1';
const API_KEY = process.env.API_KEY;
const MAX_BODY = 10 * 1024;
const MAKE_WEBHOOK_URL = process.env.MAKE_WEBHOOK_URL;

// Las cotizaciones se ejecutan de a una (perfil persistente del navegador)
let cola = Promise.resolve();
let pendientes = 0;
// Estado de cada cotización por id (en memoria; se pierde al reiniciar)
const trabajos = new Map();

const sendJson = (res, status, data) => {
    res.writeHead(status, { 'Content-Type': 'application/json; charset=utf-8' });
    res.end(JSON.stringify(data));
};

const autorizado = req => {
    if (!API_KEY) return true;
    const recibido = Buffer.from(String(req.headers['x-api-key'] || ''));
    const esperado = Buffer.from(API_KEY);
    return recibido.length === esperado.length && crypto.timingSafeEqual(recibido, esperado);
};

const leerJson = req => new Promise((resolve, reject) => {
    let body = '';
    req.on('data', chunk => {
        body += chunk;
        if (body.length > MAX_BODY) {
            reject(Object.assign(new Error('Cuerpo demasiado grande'), { status: 413 }));
            req.destroy();
        }
    });
    req.on('end', () => {
        try {
            resolve(body ? JSON.parse(body) : {});
        } catch {
            reject(Object.assign(new Error('JSON inválido'), { status: 400 }));
        }
    });
    req.on('error', reject);
});

const validar = body => {
    const tipo = String(body.tipoVehiculo ?? body.tipo_vehiculo ?? process.env.TIPO_VEHICULO ?? '').trim();
    const datos = {
        cedula: String(body.cedula ?? process.env.CEDULA_CONSULTA ?? '').replace(/\D/g, ''),
        placa: String(body.placa ?? process.env.PLACA ?? '').replace(/[^a-z0-9]/gi, '').toUpperCase(),
        tipoVehiculo: /moto/i.test(tipo) ? 'Moto' : /carro|auto|camioneta|veh/i.test(tipo) ? 'Carro' : tipo,
        ciudad: String(body.ciudad ?? process.env.CIUDAD ?? '').trim(),
        ciudadCirculacion: String(body.ciudadCirculacion ?? body.ciudad ?? process.env.CIUDAD_CIRCULACION ?? '').trim()
    };
    const telefono = String(body.telefono ?? '').replace(/\D/g, '');

    const errores = [];
    if (!/^\d{5,15}$/.test(datos.cedula)) errores.push('cedula debe tener entre 5 y 15 dígitos');
    if (!/^[A-Z0-9]{5,7}$/.test(datos.placa)) errores.push('placa debe ser alfanumérica de 5 a 7 caracteres');
    if (!/^(carro|moto)$/i.test(datos.tipoVehiculo)) errores.push('tipoVehiculo debe ser "Carro" o "Moto"');
    for (const campo of ['ciudad', 'ciudadCirculacion']) {
        if (!/^[\p{L} .()-]{2,60}$/u.test(datos[campo])) errores.push(`${campo} es inválida`);
    }
    return { datos, telefono, errores };
};

async function notificarMake(payload) {
    if (!MAKE_WEBHOOK_URL) return console.warn('[API] MAKE_WEBHOOK_URL no definida; resultado no notificado.');
    try {
        const r = await fetch(MAKE_WEBHOOK_URL, {
            method: 'POST',
            headers: { 'Content-Type': 'application/json' },
            body: JSON.stringify(payload),
            signal: AbortSignal.timeout(30000)
        });
        console.log(`[API] Webhook Make respondió ${r.status} para ${payload.id}`);
    } catch (error) {
        console.error(`[API] No se pudo notificar a Make (${payload.id}):`, error.message);
    }
}

async function procesarCotizacion(id, datos, telefono) {
    const inicio = Date.now();
    trabajos.set(id, { id, estado: 'procesando' });
    try {
        console.log(`[API] ${id} iniciando: ${datos.cedula} / ${datos.placa}`);
        const archivo = path.basename(await ejecutarCotizacion(datos));
        const resultado = {
            id, ok: true, telefono, cedula: datos.cedula, placa: datos.placa, archivo,
            descarga: `/pdf/${encodeURIComponent(archivo)}`,
            duracionSegundos: Math.round((Date.now() - inicio) / 1000)
        };
        trabajos.set(id, { ...resultado, estado: 'completado' });
        await notificarMake(resultado);
    } catch (error) {
        console.error(`[API] ${id} error:`, error.message);
        const resultado = { id, ok: false, telefono, cedula: datos.cedula, placa: datos.placa, error: error.message };
        trabajos.set(id, { ...resultado, estado: 'error' });
        await notificarMake(resultado);
    } finally {
        pendientes--;
    }
}

async function cotizar(req, res) {
    const { datos, telefono, errores } = validar(await leerJson(req));
    if (errores.length) return sendJson(res, 400, { ok: false, errores });

    const id = crypto.randomUUID();
    pendientes++;
    trabajos.set(id, { id, estado: 'en_cola' });
    // Responder antes de iniciar el scraping para que Make cierre la conexión
    sendJson(res, 200, { ok: true, id, estado: 'en_cola', posicion: pendientes });

    cola = cola.then(() => procesarCotizacion(id, datos, telefono));
}

function servirPdf(res, nombre, inline) {
    // basename evita path traversal (../)
    const archivo = path.basename(decodeURIComponent(nombre));
    const ruta = path.join(PDF_DIR, archivo);
    if (!archivo.endsWith('.pdf') || !fs.existsSync(ruta)) return sendJson(res, 404, { ok: false, error: 'PDF no encontrado' });

    res.writeHead(200, {
        'Content-Type': 'application/pdf',
        'Content-Disposition': `${inline ? 'inline' : 'attachment'}; filename="${archivo}"`
    });
    fs.createReadStream(ruta).pipe(res);
}

const server = http.createServer(async (req, res) => {
    const { pathname, searchParams } = new URL(req.url, `http://${req.headers.host || 'localhost'}`);
    try {
        if (req.method === 'GET' && pathname === '/health') return sendJson(res, 200, { ok: true, pendientes });
        if (req.method === 'GET' && pathname === '/diag') {
            // Diagnóstico temporal: conectividad del contenedor hacia el portal de Sura
            const inicio = Date.now();
            try {
                const r = await fetch('https://cotizadores.sura.com/#/Inicio', {
                    signal: AbortSignal.timeout(25000),
                    headers: { 'User-Agent': 'Mozilla/5.0 (X11; Linux x86_64) AppleWebKit/537.36 Chrome/140.0.0.0 Safari/537.36' }
                });
                const texto = (await r.text()).slice(0, 200);
                return sendJson(res, 200, { ok: true, status: r.status, ms: Date.now() - inicio, snippet: texto });
            } catch (error) {
                return sendJson(res, 200, { ok: false, error: error.message, ms: Date.now() - inicio });
            }
        }
        if (!autorizado(req)) return sendJson(res, 401, { ok: false, error: 'No autorizado' });
        if (req.method === 'POST' && pathname === '/cotizar') return await cotizar(req, res);
        if (req.method === 'GET' && pathname.startsWith('/pdf/')) return servirPdf(res, pathname.slice(5), searchParams.get('inline') === '1');
        if (req.method === 'GET' && pathname.startsWith('/estado/')) {
            const trabajo = trabajos.get(pathname.slice(8));
            return trabajo ? sendJson(res, 200, trabajo) : sendJson(res, 404, { ok: false, error: 'Cotización no encontrada' });
        }
        sendJson(res, 404, { ok: false, error: 'Ruta no encontrada' });
    } catch (error) {
        sendJson(res, error.status || 500, { ok: false, error: error.status ? error.message : 'Error interno' });
    }
});

server.listen(PORT, HOST, () => {
    console.log(`API escuchando en http://${HOST}:${PORT}`);
    if (!API_KEY) console.warn('API_KEY no definida: la API no exige autenticación.');
});
