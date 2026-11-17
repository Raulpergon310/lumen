# Lumen social

Un servicio pequeño que se instala junto a Jellyfin y le da a Lumen lo que Jellyfin no comparte entre usuarios:

- **Puntuaciones** de 1 a 5 estrellas en la ficha de cada película o serie. Todos ven la media y la nota de cada amigo.
- **Recomendar** una película o serie a uno o varios amigos, con un mensaje opcional. A ellos les sale un aviso al abrir
  Lumen, una fila «Te recomiendan tus amigos» en Inicio y una nota en la ficha.
- **Tengo que verla**: una lista propia que sale en Inicio. Lo que ya has visto desaparece solo.
- **Quién la ha visto**: en la ficha, para todos los usuarios y no solo para el administrador.

Gasta muy poco: unos 30–50 MB de memoria y casi nada de procesador. Los datos van en un único archivo, `data/data.json`.

## Instalación con Docker (NAS)

1. En Jellyfin, ve a **Panel de control → Claves API → +** y crea una clave llamada `Lumen social`.
2. Copia esta carpeta `social` al NAS.
3. Edita `docker-compose.yml`: pon en `JELLYFIN_URL` la dirección de Jellyfin vista desde el NAS y en `JELLYFIN_API_KEY` la clave.
4. Arranca el servicio:

   ```bash
   docker compose up -d --build
   ```

## Instalación sin Docker

Necesitas Node.js 20 o más reciente. No hay que instalar nada más.

```bash
JELLYFIN_URL=http://localhost:8096 JELLYFIN_API_KEY=tu-clave node server.js
```

| Variable | Por defecto | Qué es |
| --- | --- | --- |
| `JELLYFIN_URL` | `http://localhost:8096` | Dónde está Jellyfin |
| `JELLYFIN_API_KEY` | (obligatoria) | Clave API de Jellyfin; nunca sale del servidor |
| `PORT` | `8097` | Puerto del servicio |
| `DATA_DIR` | `./data` | Carpeta donde se guardan los datos |

## Cómo lo encuentra Lumen

- **En casa:** si Jellyfin va por `http://`, Lumen prueba solo el puerto 8097 de la misma máquina. No hay que configurar nada.
- **Desde fuera o en la web (https):** la web de Lumen va por https y no puede hablar con un servicio `http`. Publica el
  servicio en el mismo proxy inverso que Jellyfin, por ejemplo en `https://jellyfin.midominio.com/lumen-social/`
  (el servicio acepta cualquier prefijo antes de `/api/`). Después:
  - pon esa dirección en **Lumen → Ajustes → Amigos**, o
  - añádela al enlace de invitación para que tus amigos no tengan que tocar nada:
    `…/app/?server=https://jellyfin.midominio.com&social=https://jellyfin.midominio.com/lumen-social`

Ejemplo para Nginx, dentro del `server` de Jellyfin:

```nginx
location /lumen-social/ {
    proxy_pass http://127.0.0.1:8097/;
}
```

## Seguridad

Cada petición lleva la sesión de Jellyfin del usuario y el servicio le pregunta a Jellyfin quién es. Nadie puede
puntuar ni recomendar en nombre de otro, y sin una sesión válida no se ve nada. La clave API solo la usa el servicio
para saber qué usuarios hay y qué ha visto cada uno.
