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
| `proxyConfig` | object | Residential | Configuración de proxy |

### Ejemplo de input

```json
{
    "keyword": "RESTAURANTES",
    "maxPagesPerProvince": 40,
    "maxConcurrency": 3,
    "delayBetweenRequests": 2000,
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

## CAPTCHAs y anti-bot

- **Proxies residenciales recomendados**: empresite puede bloquear datacenter IPs
- **Delay entre requests**: mínimo 2 segundos recomendado
- **Concurrencia baja**: máximo 3-5 browsers paralelos
- **Empresite NO usa CAPTCHA agresivo** tipo reCAPTCHA/hCaptcha, pero sí rate-limiting (HTTP 429)
- Con proxies residenciales de Apify y delays apropiados, no deberías tener problemas

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
