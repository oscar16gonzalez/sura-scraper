const { chromium } = require('playwright');
const path = require('node:path');
const fs = require('node:fs/promises');
require('dotenv').config();

const PROFILE_DIR = path.join(__dirname, '.auth', 'profile');
const SCREENSHOT_DIR = path.join(__dirname, 'assets', 'img');
const PDF_DIR = path.join(__dirname, 'assets', 'pdf');
const MFA_TIMEOUT = Number(process.env.MFA_TIMEOUT_MS) || 5 * 60 * 1000;
// Pausa entre pasos del cotizador: Sura recalcula la tarifa con cada cambio
const PAUSA_COTIZADOR_MS = Number(process.env.PAUSA_COTIZADOR_MS) || 2500;
const isAppUrl = url => new URL(url).hostname === 'cotizadores.sura.com';

const Utils = {
    randomDelay(min = 1500, max = 3500) {
        const delay = Math.floor(Math.random() * (max - min + 1) + min);
        return new Promise(resolve => setTimeout(resolve, delay));
    },

    async retry(action, retries = 3, interval = 2000) {
        for (let i = 0; i < retries; i++) {
            try {
                return await action();
            } catch (err) {
                if (i === retries - 1) throw err;
                console.warn(`Intento ${i + 1} fallido. Reintentando en ${interval}ms...`);
                await new Promise(res => setTimeout(res, interval));
            }
        }
    }
};

class SuraScraper {
    constructor() {
        this.baseUrl = 'https://cotizadores.sura.com/#/Inicio';
        this.results = [];
    }

    async init() {
        // Perfil persistente: conserva cookies/localStorage, incluida la marca de "recordar dispositivo"
        this.context = await chromium.launchPersistentContext(PROFILE_DIR, {
            headless: process.env.HEADLESS === 'true',
            // En contenedores: sin sandbox de kernel y /dev/shm en /tmp (evita crashes de pestañas)
            args: ['--no-sandbox', '--disable-setuid-sandbox', '--disable-dev-shm-usage', '--disable-gpu'],
            viewport: { width: 1280, height: 720 }
        });
        this.page = this.context.pages()[0] || await this.context.newPage();
    }

    async login(docType, username, password, mfaProvider) {
        console.log('Iniciando proceso de autenticación...');
        // Redirige a login.sura.com/sso si no hay sesión activa
        // domcontentloaded: el portal SPA puede no disparar 'load' por recursos externos colgados
        await this.page.goto(this.baseUrl, { waitUntil: 'domcontentloaded', timeout: 60000 });
        await this.page.locator('#dropdownMenuButton, #suraName').first().waitFor({ timeout: 30000 });

        if (isAppUrl(this.page.url())) {
            console.log('Sesión previa activa, se omite el login.');
            return;
        }

        try {
            await Utils.retry(async () => {
                await this.page.selectOption('#ctl00_ContentMain_suraType', docType, { timeout: 10000 });
                await this.page.fill('#suraName', username);
            });

            // La clave se ingresa con un teclado virtual de orden aleatorio
            await this.page.focus('#suraPassword');
            await this.page.waitForSelector('.ui-keyboard', { state: 'visible' });
            for (const digit of password) {
                await this.page.click(`.ui-keyboard button[data-value="${digit}"] >> visible=true`);
                await Utils.randomDelay(150, 400);
            }
            await this.page.click('.ui-keyboard-accept >> visible=true');

            await this.page.click('#session-internet');
            await this.handleMfa(mfaProvider);
            await this.page.waitForSelector('#dropdownMenuButton', { timeout: 30000 });
            console.log('Login exitoso.');
        } catch (error) {
            throw new Error(`Error en el login: ${error.message}`);
        }
    }

    async handleMfa(mfaProvider) {
        try {
            await this.page.waitForURL(isAppUrl, { timeout: 10000 });
            return;
        } catch {
            // Sin redirección inmediata: se asume que se está solicitando MFA
        }

        // Sin proveedor de código: comportamiento clásico (manual o error en headless)
        if (!mfaProvider) {
            if (process.env.HEADLESS === 'true') {
                throw new Error('Se requiere MFA. Ejecute con HEADLESS=false para ingresarlo manualmente.');
            }
            console.log(`MFA requerido: ingrese el código en el navegador (tiempo máximo ${MFA_TIMEOUT / 1000}s).`);
            console.log('Si aparece la opción "recordar este dispositivo", márquela.');
            await this.page.waitForURL(isAppUrl, { timeout: MFA_TIMEOUT });
            return;
        }

        // Flujo con front: se solicita el código al usuario y se espera (mín. 1 min) antes de aplicarlo
        console.log('[MFA] Página de verificación detectada; pidiendo el código al usuario…');
        const codigo = await mfaProvider();
        console.log(`[MFA] Código recibido (${codigo.length} dígitos); ingresándolo en la página…`);
        await this.ingresarCodigoMfa(codigo);
        try {
            await this.page.waitForURL(isAppUrl, { timeout: MFA_TIMEOUT });
        } catch {
            throw new Error('El código MFA fue rechazado o la sesión no avanzó tras ingresarlo.');
        }
        console.log('[MFA] Verificación aceptada.');
    }

    async ingresarCodigoMfa(codigo) {
        // Pantallazo de diagnóstico (siempre en modo intento)
        try {
            await fs.mkdir(SCREENSHOT_DIR, { recursive: true });
            await this.screenshot('mfa');
        } catch (error) {
            console.warn('[MFA] No se pudo guardar el pantallazo:', error.message);
        }

        // Buscar el campo del código: autocomplete one-time-code y variantes comunes
        const candidatos = [
            'input[autocomplete="one-time-code"]',
            'input[type="tel"]',
            'input[type="number"]',
            'input[id*="otp" i], input[name*="otp" i]',
            'input[id*="codigo" i], input[name*="codigo" i]',
            'input[id*="code" i], input[name*="code" i]',
            'input[type="password"]'
        ];
        let input = null;
        for (const selector of candidatos) {
            const l = this.page.locator(selector).locator('visible=true').first();
            if (await l.count().catch(() => 0) && await l.isVisible().catch(() => false)) {
                input = l;
                break;
            }
        }
        if (!input) throw new Error('No se encontró el campo del código MFA en la página.');
        await input.click();

        // Sura usa teclado virtual en la clave; si aparece aquí también, se usan los botones
        const tecladoVirtual = await this.page.locator('.ui-keyboard').locator('visible=true').count().catch(() => 0);
        if (tecladoVirtual) {
            for (const digit of codigo) {
                await this.page.click(`.ui-keyboard button[data-value="${digit}"] >> visible=true`);
                await Utils.randomDelay(150, 400);
            }
            const aceptar = this.page.locator('.ui-keyboard-accept').locator('visible=true').first();
            if (await aceptar.count().catch(() => 0)) await aceptar.click().catch(() => {});
        } else {
            await input.fill('');
            await input.pressSequentially(codigo, { delay: 120 });
        }

        // Confirmar: botón con texto típico o Enter como respaldo
        const boton = this.page
            .locator('button:visible, input[type="submit"]:visible, a.btn:visible')
            .filter({ hasText: /continuar|ingresar|verificar|validar|aceptar|enviar|accept|continue/i })
            .first();
        if (await boton.count().catch(() => 0)) {
            await boton.click().catch(() => {});
        } else {
            await input.press('Enter').catch(() => {});
        }
    }

    async goToNuevoAutos() {
        console.log('Navegando a Soluciones > Seguros Autos > Nuevo...');
        const item = text => this.page.locator('app-menu a.dropdown-item', { hasText: text }).first();

        // Esperar a que termine el spinner "Cargando Información del Perfil"
        await this.page.waitForSelector('.block-ui-wrapper.active', { state: 'detached', timeout: 90000 });
        // Sin delegaciones asignadas el portal deja el menú vacío
        const menuCargado = await item(/^\s*Soluciones\s*$/).waitFor({ state: 'attached', timeout: 45000 }).then(() => true, () => false);
        if (!menuCargado) {
            throw new Error('El portal de Sura no cargó el menú (no hay delegaciones/asesor disponibles para el usuario). Verifique en el navegador que el selector superior muestre la agencia, o cierre sesión y vuelva a ingresar.');
        }
        // Los ítems existen ocultos en el DOM; el dropdown se cierra tras cada clic
        await item(/^\s*Soluciones\s*$/).dispatchEvent('click');
        await item(/^\s*Seguros Autos\s*$/).dispatchEvent('click');
        await item(/^\s*Nuevo\s*$/).dispatchEvent('click');

        await this.page.getByText('Buscar persona').waitFor({ state: 'visible', timeout: 15000 });
        console.log('Formulario "Buscar persona" abierto.');
    }

    async buscarPersona(documento, tipoDocumento = 'CEDULA') {
        console.log(`Buscando persona ${tipoDocumento} ${documento}...`);
        const dialog = this.page.locator('app-consulta-cliente-dialog');

        await dialog.locator('mat-select[formcontrolname="tipoControl"]').click();
        await this.page.locator('mat-option', { hasText: new RegExp(`^\\s*${tipoDocumento}\\s*$`) }).click();
        await dialog.locator('input[formcontrolname="documentControl"]').fill(documento);

        const aceptar = dialog.locator('button', { hasText: 'Aceptar' });
        await aceptar.click();
        await dialog.waitFor({ state: 'detached', timeout: 15000 });
        await this.page.waitForURL(/#\/Clientes/, { timeout: 60000 });
        await this.page.getByText('Datos básicos').first().waitFor({ state: 'visible', timeout: 60000 });
        // Spinner "Realizando consulta del cliente" de ng-block-ui
        await this.page.waitForSelector('.block-ui-wrapper.active', { state: 'detached', timeout: 90000 });
        console.log('Búsqueda enviada.');
    }

    async llenarDireccionResidencia(direccion, ciudad) {
        console.log(`Diligenciando dirección de Residencia: ${direccion} / ${ciudad}...`);
        // Si el cliente ya tiene direcciones guardadas aparecen como filas deshabilitadas
        const row = this.page.locator('app-direccion-cliente .form-row')
            .filter({ has: this.page.locator('mat-radio-button', { hasText: 'Residencia' }) })
            .filter({ hasNot: this.page.locator('.mat-radio-disabled') });

        await row.locator('mat-radio-button').click();
        await row.locator('input[placeholder="Dirección"]').fill(direccion);

        const ciudadInput = row.locator('input[placeholder="Ciudad"]');
        await ciudadInput.fill('');
        // El autocompletado solo se dispara con eventos de teclado
        await ciudadInput.pressSequentially(ciudad, { delay: 80 });
        await this.page.locator('mat-option').first().waitFor({ state: 'visible', timeout: 15000 });
        const ciudadRegex = new RegExp(ciudad.replace(/[.*+?^${}()|[\]\\]/g, '\\$&'), 'i');
        const opcion = this.page.locator('mat-option', { hasText: ciudadRegex }).first();
        console.log(`Ciudad seleccionada: ${(await opcion.innerText()).trim()}`);
        await opcion.click();

        await this.page.locator('button', { hasText: 'Continuar' }).click();
        // El spinner puede tardar en aparecer; si no aparece se continúa
        await this.page.waitForSelector('.block-ui-wrapper.active', { timeout: 5000 }).catch(() => {});
        await this.page.waitForSelector('.block-ui-wrapper.active', { state: 'detached', timeout: 90000 });
        console.log(`Continuar enviado. URL actual: ${this.page.url()}`);
    }

    // Cotizador de autos (Polymer): los localizadores de Playwright atraviesan el Shadow DOM
    async cotizarVehiculo({ tipoVehiculo, placa, ciudad, tipoServicio = 'Particular', uso = 'Familiar', formaPago = 'F Mensual 11' }) {
        const p = this.page;
        const escape = text => text.replace(/[.*+?^${}()|[\]\\]/g, '\\$&');
        const exact = text => new RegExp(`^\\s*${escape(text)}\\s*$`, 'i');
        const pausa = () => p.waitForTimeout(PAUSA_COTIZADOR_MS);
        const esperarCalculo = () => p.locator('p.loading-tarifa').waitFor({ state: 'hidden', timeout: 120000 });

        const planId = /moto/i.test(tipoVehiculo) ? 'Plan Motos' : 'Plan Autos Clásico';
        console.log(`Seleccionando ${planId}...`);
        const plan = p.locator(`[id="${planId}"]`);
        await plan.waitFor({ state: 'visible', timeout: 90000 });
        await plan.click();

        console.log(`Buscando placa ${placa}...`);
        await p.locator('paper-input#placa input').waitFor({ state: 'visible', timeout: 30000 });
        await p.locator('paper-input#placa input').fill(placa);
        await p.locator('#searchPlaca').click();
        await p.locator('paper-spinner[active], paper-progress[indeterminate]:not([hidden])').first()
            .waitFor({ state: 'hidden', timeout: 60000 }).catch(() => {});
        await p.waitForTimeout(2000);

        const aviso = await this.leerDialogo(8000);
        if (aviso) throw new Error(`${aviso.titulo} al buscar la placa ${placa}: ${aviso.mensaje}`);

        console.log(`Tipo de servicio: ${tipoServicio}`);
        await p.locator('dropdown-list#tipoServicio paper-dropdown-menu').click();
        await p.locator('dropdown-list#tipoServicio paper-item', { hasText: exact(tipoServicio) }).click();
        await pausa();

        console.log(`Ciudad de circulación: ${ciudad}`);
        // Las direcciones del cliente también usan combo-box#ciudad
        const ciudadInput = p.locator('#paperCardInfoVehiculo combo-box#ciudad input');
        await ciudadInput.fill('');
        await ciudadInput.pressSequentially(ciudad, { delay: 80 });
        const ciudadItem = p.locator('vaadin-combo-box-item', { hasText: new RegExp(escape(ciudad), 'i') }).first();
        await ciudadItem.waitFor({ state: 'visible', timeout: 15000 });
        console.log(`Ciudad seleccionada: ${(await ciudadItem.innerText()).trim()}`);
        await ciudadItem.click();
        await pausa();
        await esperarCalculo();

        console.log(`Uso del vehículo: ${uso}`);
        await p.locator('radio-group#usoVehiculo paper-radio-button', { hasText: exact(uso) }).click();
        await pausa();
        await esperarCalculo();

        console.log(`Forma de pago: ${formaPago}`);
        await p.locator('radio-group#formaPago paper-radio-button', { hasText: exact(formaPago) }).click();
        await pausa();

        console.log('Esperando el cálculo de la tarifa...');
        await p.getByText('La tarifa se mostrará en esta sección').waitFor({ state: 'hidden', timeout: 120000 });
        console.log(`Tarifa estable: ${await this.esperarTarifaEstable()}`);
        await pausa();

        const urlDatosBasicos = p.url();
        console.log('Clic en "Ver cotización"...');
        await p.locator('paper-button', { hasText: 'Ver cotización' }).click();

        const aviso2 = await this.leerDialogo(15000);
        if (aviso2) {
            if (!/continuidad/i.test(aviso2.mensaje)) {
                throw new Error(`${aviso2.titulo} al ver la cotización: ${aviso2.mensaje}`);
            }
            console.log(`Aviso aceptado: ${aviso2.mensaje}`);
        }

        await p.waitForURL(url => url !== urlDatosBasicos && !/datosBasicos/.test(url), { timeout: 60000 })
            .catch(() => console.warn('No se detectó cambio de URL tras "Ver cotización"; se continúa.'));
        console.log(`Cotización abierta. URL actual: ${p.url()}`);
    }

    // Devuelve el texto de la tarjeta de resultado cuando dos lecturas seguidas coinciden
    async esperarTarifaEstable(timeout = 90000) {
        const tarjeta = this.page.locator('paper-card.card-resultado').first();
        const limite = Date.now() + timeout;
        let anterior = null;
        while (Date.now() < limite) {
            await this.page.locator('p.loading-tarifa').waitFor({ state: 'hidden', timeout: 120000 });
            const actual = (await tarjeta.innerText().catch(() => '')).replace(/\s+/g, ' ').trim();
            if (actual && actual === anterior) return actual;
            anterior = actual;
            await this.page.waitForTimeout(3000);
        }
        throw new Error('La tarifa no se estabilizó a tiempo');
    }

    async descargarPdf(nombre) {
        const p = this.page;
        console.log('Abriendo menú del cotizador para generar el PDF...');
        await p.locator('actions-menu#menuCotizador paper-icon-button').click();
        const opcionPdf = p.locator('actions-menu#menuCotizador paper-item', { hasText: /pdf/i }).first();
        await opcionPdf.waitFor({ state: 'visible', timeout: 15000 });

        // El PDF puede descargarse directamente o abrirse en una pestaña nueva
        const evento = Promise.race([
            p.waitForEvent('download', { timeout: 90000 }).then(download => ({ download })),
            this.context.waitForEvent('page', { timeout: 90000 }).then(popup => ({ popup }))
        ]);
        await opcionPdf.click();
        const { download, popup } = await evento;

        const stamp = new Date().toISOString().replace(/[:.]/g, '-');
        const file = path.join(PDF_DIR, `${nombre}_${stamp}.pdf`);

        if (download) {
            await download.saveAs(file);
        } else {
            // La pestaña muestra "Generando PDF..." en about:blank y luego carga el PDF como blob:
            console.log('Esperando a que Sura genere el PDF...');
            const resultado = await Promise.race([
                popup.waitForEvent('download', { timeout: 120000 }).then(dl => ({ dl })),
                popup.waitForEvent('response', {
                    predicate: r => /application\/pdf/i.test(r.headers()['content-type'] || ''),
                    timeout: 120000
                }).then(res => ({ res }))
            ]);

            if (resultado.dl) {
                await resultado.dl.saveAs(file);
            } else {
                const url = resultado.res.url();
                const fetchBlob = async () => Buffer.from(
                    await p.evaluate(async u => [...new Uint8Array(await (await fetch(u)).arrayBuffer())], url)
                );
                let bytes = await resultado.res.body().catch(() => null);
                // Con navegador visible, el visor de PDF de Chrome reemplaza el cuerpo por su HTML
                if (!bytes || bytes.subarray(0, 4).toString() !== '%PDF') bytes = await fetchBlob();
                if (bytes.subarray(0, 4).toString() !== '%PDF') throw new Error(`El contenido descargado de ${url} no es un PDF`);
                await fs.mkdir(PDF_DIR, { recursive: true });
                await fs.writeFile(file, bytes);
            }
            await popup.close().catch(() => {});
        }
        console.log(`PDF guardado en ${file}`);
        return file;
    }

    // Devuelve { titulo, mensaje } del diálogo simple-dialog visible y lo cierra, o null
    async leerDialogo(timeout) {
        const dialogo = this.page.locator('simple-dialog paper-dialog#dialogBase');
        const visible = await dialogo.first().waitFor({ state: 'visible', timeout }).then(() => true, () => false);
        if (!visible) return null;

        const lineas = (await dialogo.first().innerText()).split('\n').map(l => l.trim()).filter(Boolean);
        const titulo = lineas.shift() || 'Aviso';
        const mensaje = lineas.filter(l => l !== 'Aceptar').join(' ');
        await dialogo.first().getByText('Aceptar', { exact: true }).click().catch(() => {});
        return { titulo, mensaje };
    }

    async screenshot(name) {
        const stamp = new Date().toISOString().replace(/[:.]/g, '-');
        const file = path.join(SCREENSHOT_DIR, `${name}_${stamp}.png`);
        await this.page.screenshot({ path: file, fullPage: true });
        console.log(`Pantallazo guardado en ${file}`);
    }

    async extractItemData(element) {
        // TODO: reemplazar con los selectores reales de cada fila
        const fields = {
            nombre: '.name-class',
            documento: '.doc-class',
            estado: '.status-label'
        };

        const data = {};
        for (const [key, selector] of Object.entries(fields)) {
            try {
                const value = await element.$(selector);
                data[key] = value ? (await value.innerText()).trim() : null;
            } catch (e) {
                console.error(`Error extrayendo ${key}: ${e.message}`);
                data[key] = null;
            }
        }
        return data;
    }

    async scrapeData() {
        console.log('Iniciando extracción de datos...');
        let hasNextPage = true;

        while (hasNextPage) {
            try {
                // TODO: ajustar selectores del contenedor, filas y paginación
                await this.page.waitForSelector('.grid-container', { timeout: 15000 });
                const items = await this.page.$$('.grid-row');

                for (const item of items) {
                    this.results.push(await this.extractItemData(item));
                }
                console.log(`Capturados ${this.results.length} registros hasta ahora...`);

                const nextButton = await this.page.$('a.next-page:not(.disabled)');
                if (nextButton) {
                    await Utils.randomDelay();
                    await nextButton.click();
                    await this.page.waitForLoadState('networkidle');
                } else {
                    hasNextPage = false;
                    console.log('No hay más páginas para recorrer.');
                }
            } catch (error) {
                console.error(`Error durante el scrapeo: ${error.message}`);
                hasNextPage = false;
            }
        }
    }

    async close() {
        if (this.context) await this.context.close();
    }
}

module.exports = { SuraScraper };

async function ejecutarCotizacion({ cedula, placa, tipoVehiculo, ciudad, ciudadCirculacion }, mfaProvider) {
    const { SURA_DOC_TYPE = 'C', SURA_USER, SURA_PASS } = process.env;
    if (!SURA_USER || !SURA_PASS) throw new Error('Faltan SURA_USER y/o SURA_PASS en el archivo .env');

    const scraper = new SuraScraper();
    try {
        await scraper.init();
        await scraper.login(SURA_DOC_TYPE, SURA_USER, SURA_PASS, mfaProvider);
        await scraper.goToNuevoAutos();
        await scraper.buscarPersona(cedula);
        await scraper.llenarDireccionResidencia(ciudad, ciudadCirculacion);
        await scraper.cotizarVehiculo({ tipoVehiculo, placa, ciudad: ciudadCirculacion });
        return await scraper.descargarPdf(`cotizacion_${cedula}_${placa}`);
    } finally {
        await scraper.close();
    }
}

module.exports.ejecutarCotizacion = ejecutarCotizacion;
module.exports.PDF_DIR = PDF_DIR;

if (require.main === module) (async () => {
    const { CEDULA_CONSULTA, CIUDAD, CIUDAD_CIRCULACION, TIPO_VEHICULO, PLACA } = process.env;
    if (!CEDULA_CONSULTA || !CIUDAD || !CIUDAD_CIRCULACION || !TIPO_VEHICULO || !PLACA) {
        console.error('Faltan variables en .env: CEDULA_CONSULTA, CIUDAD, CIUDAD_CIRCULACION, TIPO_VEHICULO y PLACA son obligatorias');
        process.exit(1);
    }

    try {
        await ejecutarCotizacion({
            cedula: CEDULA_CONSULTA,
            placa: PLACA,
            tipoVehiculo: TIPO_VEHICULO,
            ciudad: CIUDAD,
            ciudadCirculacion: CIUDAD_CIRCULACION
        });
    } catch (error) {
        console.error('Error Fatal:', error.message);
        process.exitCode = 1;
    }
})();
