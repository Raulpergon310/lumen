# Lumen

Cliente ligero y bonito para [Jellyfin](https://jellyfin.org), con estética tipo Apple TV / Infuse.
Funciona en **Windows**, **Android TV / Google TV** y en el **navegador**.

## Instalar

La forma fácil es la página del proyecto (GitHub Pages), con enlaces a la última versión de todo.

- **Windows:** descarga `Lumen-Setup-<versión>.exe` de [Releases](../../releases/latest). No necesita administrador,
  crea accesos directos y se actualiza sola. Windows puede avisar de que la app es nueva: «Más información» →
  «Ejecutar de todas formas».
- **Android TV:** instala la app *Downloader* desde Google Play y escribe la dirección corta que aparece en la página
  del proyecto (termina en `/tv`), o instala `Lumen-tv.apk` de [Releases](../../releases/latest). La app avisa sola
  cuando hay una versión nueva. Con VLC instalado, el 4K y el HDR se reproducen en VLC.
- **Navegador:** abre la página del proyecto → «Abrir Lumen». El servidor Jellyfin debe tener dirección `https`.

Para entrar hace falta una cuenta en un servidor Jellyfin. Quien comparte su servidor puede mandar un enlace de
invitación con la dirección ya puesta: `https://<usuario>.github.io/<repo>/?server=https://mi-jellyfin.ejemplo.com`.

## Qué hace

- La ventana aparece al instante; la conexión con el servidor va aparte y nunca bloquea la interfaz.
- Dos direcciones por servidor (casa y fuera); usa la primera que conteste.
- Reproducción directa de la imagen original siempre que se puede. Si el audio es Dolby Digital, DTS o TrueHD,
  el servidor convierte solo el audio.
- En Windows, lo que el reproductor integrado no muestra bien (HDR, Dolby Vision, Atmos/TrueHD/DTS, subtítulos de
  anime con estilo) pasa a **mpv**, integrado en la ventana. En Android TV, el 4K y el HDR pasan a **VLC**.
- Subtítulos ASS/SSA con libass (JASSUB), subtítulos en español automáticos, saltar intro (con el plugin
  Intro Skipper en el servidor), siguiente episodio, progreso sincronizado con Jellyfin.
- Búsqueda de títulos, actores y directores; marcar temporadas enteras como vistas; recomendaciones que cambian.
- En la tele se maneja con el mando: flechas, OK, Atrás y los botones multimedia.

### Atajos en el reproductor (Windows)

| Tecla | Acción |
| --- | --- |
| Espacio / K | Reproducir / pausa |
| ← / → | −10 s / +30 s |
| ↑ / ↓ | Volumen |
| F o doble clic | Pantalla completa |
| M | Silenciar |
| N | Siguiente episodio |
| S | Saltar intro |
| Esc | Salir |

## Desarrollo

```bash
npm install
npm start          # Windows (Electron)
npm run dev        # en el navegador: http://localhost:5178
npm run web        # construye la web estática en site/
```

- **mpv** no está en el repositorio (pesa más de 100 MB): descarga una build de mpv para Windows
  ([shinchiro/mpv-winbuild-cmake](https://github.com/shinchiro/mpv-winbuild-cmake/releases)) y copia `mpv.exe`
  y sus DLL en `vendor/mpv/`.
- **Instalador de Windows:** `npm run instalador` → `dist/Lumen-Setup-<versión>.exe`.
- **Android TV:** `bash android/build.sh` → `dist/Lumen-tv.apk`. Usa el SDK de Android y el JDK de Android Studio,
  sin Gradle. La clave de firma vive fuera del repositorio, en `~/.lumen/` (`lumen-tv.keystore` + `keystore.pass`);
  si no existe se crea una. Las teles con la app instalada solo aceptan actualizaciones firmadas con la misma clave.
- **Publicar una versión:** sube `version` en `package.json` y ejecuta `npm run release -- "novedades"`
  (necesita `gh` con sesión iniciada). Las apps instaladas la encuentran solas.
- La web se publica sola en GitHub Pages en cada push a `main` (`.github/workflows/web.yml`).

Configuración y registro de la app de Windows en `%APPDATA%\Lumen\` (`config.json`, `lumen.log`).

## Licencia

MIT
