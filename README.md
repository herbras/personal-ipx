# IPX Server

An image processing server powered by [IPX](https://github.com/unjs/ipx) and [Bun](https://bun.sh/), containerized with [Docker](https://www.docker.com/).

## Features

*   Dynamic image resizing, cropping, and optimization via IPX.
*   Configurable image sources (local filesystem, HTTP/HTTPS).
*   Configurable cache TTL for processed images.
*   Health check endpoint.
*   Optimized for production with multi-stage Docker builds.

## Prerequisites

*   [Bun](https://bun.sh/docs/installation) (v1.2.x or later recommended)
*   [Docker](https://docs.docker.com/get-docker/) and Docker Compose

## Configuration

The application is configured through `app/config.yml`. You can adjust settings such as:

*   `server.port`: The port the server listens on (default: `3000`).
*   `ipxSettings.fsDir`: The local directory for filesystem-based image sourcing (default: `./public`).
*   `ipxSettings.httpStorage.domains`: A list of allowed domains for HTTP/HTTPS image sourcing.
*   `ipxSettings.imageCacheTTLSeconds`: Time-to-live for cached images in seconds (default: 1 year).

Example `app/config.yml`:
```yaml
server:
  port: 3000

ipxSettings:
  fsDir: './public'
  httpStorage:
    domains:
      - 'your-image-storage-domain.com'
  imageCacheTTLSeconds: 31536000
```
Make sure to create and populate the `public` directory inside the `app` folder (e.g., `app/public/images/...`) if you intend to use `fsDir` for local file serving. This path is relative to the application's root *inside the container* (`/app`).

## Local Development

1.  **Install Dependencies:**
    ```bash
    bun install
    ```

2.  **Run the Development Server:**
    This will start the server with hot reloading.
    ```bash
    bun run dev
    ```
    The server will be available at `http://localhost:3000` (or the port specified in `app/config.yml`).

## Building for Production (Manual)

To build the application for production without Docker:

```bash
bun run build
```
This will output the built files to the `dist` directory.

## Running with Docker

This is the recommended way to run the application in production.

1.  **Build the Docker Image:**
    If you're on Windows using WSL for Docker:
    ```bash
    wsl docker compose build --no-cache
    ```
    Otherwise:
    ```bash
    docker compose build --no-cache
    ```
    *(The `--no-cache` flag is recommended initially to ensure all layers are rebuilt with the latest changes, but can be omitted for subsequent builds if no Dockerfile changes were made.)*

2.  **Run the Docker Container:**
    If you're on Windows using WSL for Docker:
    ```bash
    wsl docker compose up
    ```
    Otherwise:
    ```bash
    docker compose up
    ```
    To run in detached mode, add the `-d` flag: `docker compose up -d`.

The server will be available at `http://localhost:3000`.

## Endpoints

*   **IPX Image Processing:** `http://localhost:3000/_ipx/...`
    Refer to the [IPX documentation](https://ipx.nuxt.com/usage/nuxt-style-urls) for URL formats (e.g., `/_ipx/s_300x200/images/my-image.jpg`).
*   **Health Check:** `http://localhost:3000/health`
    Returns a JSON response indicating the server status. Example:
    ```json
    { "status": "ok", "timestamp": "2024-01-01T12:00:00.000Z" }
    ```

## Project Structure

```
.
├── Dockerfile
├── app/
│   ├── config.yml      # Application configuration
│   ├── index.ts        # Main application entry point
│   └── public/         # Example directory for local image serving (ipxSettings.fsDir)
├── bun.lock            # Bun lockfile
├── docker-compose.yml
├── package.json
├── README.md
└── tsconfig.json
```
