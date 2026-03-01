# Empresite Spain Business Directory Scraper

Actor de Apify para scrapear [empresite.eleconomista.es](https://empresite.eleconomista.es) - el mayor directorio de empresas de España.

## Qué hace

1. Recibe una **palabra clave** (ej: "INSTALACIONES", "RESTAURANTES")
2. **Rota por las 52 provincias** de España automáticamente
3. **Pagina hasta 40 páginas** (1,200 resultados) por provincia
4. Resultado máximo teórico: **62,400 empresas** por keyword

### Por qué rota por provincias

Empresite limita **cualquier búsqueda a 40 páginas** (1,200 resultados). Si buscás "RESTAURANTES" hay 35,000+ pero solo verías 1,200. Al buscar provincia por provincia, se obtiene hasta 1,200 por provincia × 52 provincias.

## Input

| Campo | Tipo | Default | Descripción |
|-------|------|---------|-------------|
| `keyword` | string | INSTALACIONES | Actividad/keyword a buscar |
| `maxPagesPerProvince` | int | 40 | Páginas máximo por provincia (1-40) |
| `provincias` | string[] | todas | Filtrar provincias específicas |
| `maxConcurrency` | int | 3 | Browsers paralelos (2-5 recomendado) |
| `delayBetweenRequests` | int | 2000 | Delay en ms entre requests |
| `captchaApiKey` | string | - | API key de [2captcha.com](https://2captcha.com) para resolver reCAPTCHA |
| `captchaMaxRetries` | int | 2 | Reintentos máximo cuando aparece CAPTCHA |
| `proxyConfig` | object | Residential | Configuración de proxy |

### Ejemplo de input

```json
{
    "keyword": "RESTAURANTES",
    "maxPagesPerProvince": 40,
    "maxConcurrency": 3,
    "delayBetweenRequests": 2000,
    "captchaApiKey": "TU_API_KEY_DE_2CAPTCHA",
    "proxyConfig": {
        "useApifyProxy": true,
        "apifyProxyGroups": ["RESIDENTIAL"]
    }
}
```

### Solo algunas provincias

```json
{
    "keyword": "INSTALACIONES",
    "provincias": ["MADRID", "BARCELONA", "VALENCIA", "SEVILLA"],
    "maxPagesPerProvince": 10
}
```

## Output

Cada empresa se guarda en el Dataset con estos campos:

| Campo | Ejemplo |
|-------|---------|
| `keyword` | INSTALACIONES |
| `provincia` | MADRID |
| `name` | Instalaciones eléctricas San Juan SL |
| `description` | Instalaciones eléctricas en general... |
| `address` | Calle Mayor, 15, 28001, Madrid, Madrid |
| `url` | https://empresite.eleconomista.es/INSTALACIONES-ELECTRICAS-SAN-JUAN.html |
| `page` | 1 |
| `scrapedAt` | 2026-03-01T15:30:00.000Z |

## Ejecución local

```bash
# Instalar dependencias
npm install

# Configurar input en .actor/input.json y ejecutar
npm start
```

## Deploy en Apify

```bash
# Instalar Apify CLI
npm install -g apify-cli

# Login
apify login

# Push a Apify
apify push
```

O conectar el repositorio de GitHub directamente desde la UI de Apify.

## reCAPTCHA y anti-bot

Empresiste **sí usa reCAPTCHA** de Google. El scraper tiene un sistema completo para manejarlo:

### Detección automática

En cada página, el scraper verifica si hay reCAPTCHA buscando:
- Widget `.g-recaptcha` con `data-sitekey`
- iframes de `google.com/recaptcha`
- Scripts de reCAPTCHA

### Resolución con 2Captcha

Si configurás `captchaApiKey` con tu API key de [2captcha.com](https://2captcha.com):

1. Detecta el reCAPTCHA y extrae el `siteKey`
2. Envía el challenge a 2Captcha (servicio de resolución humana, ~$3/1000 CAPTCHAs)
3. Espera la solución (normalmente 15-45 segundos)
4. Inyecta el token en la página y continúa

### Sin 2Captcha

Si no tenés API key, el scraper:
1. Detecta el CAPTCHA
2. Reintenta con **IP de proxy diferente** (a veces el CAPTCHA se dispara solo con ciertas IPs)
3. Si después de `captchaMaxRetries` intentos sigue apareciendo, salta esa página

### Recomendaciones para minimizar CAPTCHAs

| Configuración | Valor recomendado | Por qué |
|---|---|---|
| Proxies | **RESIDENTIAL** | IPs residenciales disparan menos CAPTCHAs |
| Concurrencia | **2-3** | Pocas conexiones simultáneas |
| Delay | **3000-5000 ms** | Simula comportamiento humano |
| 2Captcha | **Recomendado** | Para cuando inevitablemente aparezca |

### Coste estimado de 2Captcha

- reCAPTCHA v2: ~$2.99 por 1,000 resoluciones
- Si scrapeas 52 provincias × 40 páginas = 2,080 páginas
- En el peor caso (CAPTCHA en cada página): ~$6.22
- Con proxies residenciales, normalmente aparece en <10% de páginas: ~$0.62

## Otras páginas de España compatibles con scraping por keyword

Estos son directorios de empresas españoles que funcionan de forma similar (búsqueda por keyword + ubicación):

| Sitio | URL | Notas |
|-------|-----|-------|
| **Páginas Amarillas** | paginasamarillas.es | El clásico. Búsqueda por actividad + localidad. Muy completo |
| **QDQ** | qdq.com | Directorio de negocios. Similar a páginas amarillas |
| **Cylex España** | cylex.es | Directorio internacional con sección España |
| **Axesor** | axesor.es | Info financiera de empresas. Más datos pero más protegido |
| **Infocif** | infocif.es | Datos oficiales del registro mercantil |
| **Europages** | europages.es | Directorio B2B europeo, filtrable por España |
| **Kompass** | kompass.com/es | Directorio B2B con info detallada |
| **Vulka** | vulka.es | Directorio local de negocios |
| **Google Maps** | google.com/maps | Requiere API o Apify actor específico |
| **eInforma** | einforma.com | La fuente madre de empresite (más datos, más protección) |

### Más prometedores para un actor genérico:

1. **Páginas Amarillas** — estructura similar, keyword + provincia, miles de resultados
2. **Cylex** — menos protección, fácil de scrapear
3. **QDQ** — buen complemento, a veces tiene empresas que no están en empresite

## Provincias soportadas

Todas las 52 provincias de España:

```
ALAVA, ALBACETE, ALICANTE, ALMERIA, ASTURIAS, AVILA, BADAJOZ, BALEARES,
BARCELONA, BURGOS, CACERES, CADIZ, CANTABRIA, CASTELLON, CEUTA, CIUDAD-REAL,
CORDOBA, CORUNA, CUENCA, GERONA, GRANADA, GUADALAJARA, GUIPUZCOA, HUELVA,
HUESCA, JAEN, LEON, LERIDA, LUGO, MADRID, MALAGA, MELILLA, MURCIA, NAVARRA,
ORENSE, PALENCIA, PALMAS, PONTEVEDRA, RIOJA, SALAMANCA, SANTA-CRUZ-TENERIFE,
SEGOVIA, SEVILLA, SORIA, TARRAGONA, TERUEL, TOLEDO, VALENCIA, VALLADOLID,
VIZCAYA, ZAMORA, ZARAGOZA
```
