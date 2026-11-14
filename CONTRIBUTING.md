# Contribuir

Los issues y los pull requests son bienvenidos.

## Reportar un error o pedir un cambio

Abre un issue con el formulario de [reporte de error](https://github.com/veriko-mx-labs/veriko-js/issues/new?template=bug_report.yml) o de [solicitud de cambio](https://github.com/veriko-mx-labs/veriko-js/issues/new?template=feature_request.yml). Busca primero entre los issues abiertos.

Un reporte de error necesita las versiones que usas, los pasos que lo reproducen y, cuando la API respondió con un error, su `request_id` (`error.requestId` en el error lanzado). Quita las claves de API, los comprobantes, los números de cuenta y los datos de clientes de todo lo que pegues.

No abras un issue público por una vulnerabilidad de seguridad. Sigue [SECURITY.md](SECURITY.md).

## Proponer un cambio

1. Para algo más grande que una corrección, abre antes un issue y acuerda el cambio antes de escribirlo.
2. Haz un fork del repositorio y crea una rama desde `main`.
3. Haz el cambio. Agrega o actualiza las pruebas en `test/`.
4. Corre las comprobaciones de este repositorio:

   ```bash
   npm ci
   npm run lint
   npm run format:check
   npm run typecheck
   npm run check:spec-public
   npm run check:types-fresh
   npm test
   npm run test:examples
   ```

   `npm run format` corrige el formato. Las pruebas nunca llegan a la API. Usa Node.js 18 o superior.

5. Actualiza README.md y CHANGELOG.md cuando cambie el comportamiento que ven los usuarios.
6. Abre un pull request contra `main` y llena la plantilla.

Escribe los mensajes de commit en español, en imperativo, y deja un solo cambio en cada commit.

`src/generated/openapi.ts` se genera desde `spec/openapi.yaml`. No lo edites a mano: corre `npm run gen:types`, y `npm run check:types-fresh` falla cuando el archivo está desactualizado.

El paquete no tiene dependencias en tiempo de ejecución. No agregues una sin abrir antes un issue.

## El contrato de la API

El contrato de la API es el spec público en <https://docs.veriko.mx/openapi.yaml>. `spec/openapi.yaml` es una copia que sincroniza un workflow programado. No la edites a mano. Cuando la API se comporte distinto del spec, abre un issue.
