# 🎬 CINEMATECA

Tu colección personal de películas.

---

## Instalación rápida

### 1. Requisitos
- **Node.js** v16 o superior → https://nodejs.org
- **MPC-HC** (Media Player Classic - Home Cinema) instalado

### 2. Primer uso

1. Hacé doble clic en **`INICIAR.bat`**
2. Espera que se instalen las dependencias (solo la primera vez)
3. El navegador se abrirá automáticamente en `http://localhost:3737`
4. Completá la configuración inicial:
   - **API Key de TMDB** (gratuita, ver abajo)
   - **Rutas de tus carpetas** de películas
   - **Ruta de MPC-HC**

### 3. Obtener API Key de TMDB (gratis)

1. Ir a https://www.themoviedb.org
2. Crear una cuenta gratuita
3. Ir a **Configuración → API → Crear**
4. Elegir "Personal" → completar el formulario
5. Copiar la **API Key (v3 auth)**

---

## Cómo funciona

### Escaneo del disco
- Hacé clic en **"Escanear disco"** en la barra lateral
- Cinemateca encuentra todos los archivos de video (.mkv, .mp4, .avi, etc.)
- Limpia el nombre del archivo (ignora calidad, codecs, etc.)
- Busca la película en TMDB automáticamente
- Si no encuentra una película, podés escribir el nombre correcto manualmente
- Toda la metadata queda guardada localmente en `data/library.json`

### Reproducción
- Hacé clic en ▶ en cualquier película
- Se abre MPC-HC directamente con madVR
- La película se marca como vista automáticamente

### Filtros y búsqueda
- **Búsqueda**: por título, director, actor, género
- **Sidebar**: filtrar por género y décadas
- **Vistas**: Toda la colección / Vistos / Sin ver / Favoritos / Por director
- **Orden**: A-Z, año, puntuación, fecha agregada, director
- **Vista**: cuadrícula o lista

---

## Estructura de carpetas

```
cinemateca/
├── INICIAR.bat          ← Arranca todo
├── backend/
│   ├── server.js        ← Servidor Node.js
│   └── package.json
├── frontend/
│   └── public/
│       └── index.html   ← La app
└── data/
    ├── config.json      ← Tu configuración (se crea automáticamente)
    └── library.json     ← Tu biblioteca (se crea automáticamente)
```

---

## Formatos soportados

`.mkv` `.mp4` `.avi` `.mov` `.m4v` `.wmv` `.flv` `.ts` `.m2ts` `.iso`

---

## Tips

- **Carpetas por director**: Cinemateca las detecta y agrupa correctamente
- **Si el escaneo identifica mal una película**: Usá el campo de corrección manual en el modal de escaneo
- **Los datos se guardan localmente**: No hay nada en la nube, todo en `data/library.json`
- **Re-escanear**: Solo agrega películas nuevas, no duplica las ya guardadas

---

## Puerto

La app corre en el puerto **3737**. Si necesitás cambiarlo, editá `server.js` en la línea donde dice `const PORT = 3737`.
