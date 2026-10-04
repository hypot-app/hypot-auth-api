# PRD - Servicio Centralizado de Autenticación

Oct 3, 2026 · @Faber Hoyos

## Visión General

Se requiere un **\*\*servicio centralizado de autenticación\*\* que maneje login, generación de tokens, validación de JWT y notificaciones por correo — \*\*sin centralizar usuarios\*\*. Cada aplicación (Blog, Tienda, Panel, etc) gestiona su propia tabla de usuarios. El servicio Auth solo provee: tokens seguros, envío de emails, reset de passwords y validación de credenciales**.

**Problemas que resuelve:**

- Cada aplicación tendría su propio sistema de login, reset password, emails → duplicación de código
- Cambios en políticas de seguridad, recuperación de contraseña u 2FA requieren tocar múltiples servidores
- No hay un único punto de verdad para quién es un usuario y en qué estado está su cuenta
- La gestión de correos (bienvenida, reset password, confirmación) no está centralizada

**Beneficios:**

- **DRY (Don't Repeat Yourself):** Una sola base de datos y lógica de auth
- **Escalabilidad:** Agregar nuevas aplicaciones sin reescribir autenticación
- **Seguridad:** Control centralizado de políticas de contraseña, refresh tokens, 2FA
- **Performance:** Validación de JWT sin latencia de red (cada app valida localmente)
- **Mantenibilidad:** Los cambios de seguridad ocurren en un solo lugar

## Objetivos

| Objetivo | Métrica | Target |
| --- | --- | --- |
| Tiempo de login | Latencia P95 | 500ms |
| Disponibilidad | Uptime | 99.9% |
| Escalabilidad | Requests/segundo | 1000 req/s |
| Adopción | Apps integrando | 5 apps en 3 meses |
| Confiabilidad | Failed logins / total | < 0.1% |
| Seguridad | Brechas de datos | 0 brechas |
| Facilidad de integración | Tiempo para nueva app | < 2 horas |
| DX (Developer Experience) | Developers satisfechos | ≥ 90% |

## Usuarios y Casos de Uso

### Usuarios Primarios

**End Users (Usuarios finales)**

- Quieren registrarse, hacer login, recuperar contraseña
- Casos: Primer acceso a una app, reset de password, cambio de email

**Developers (Equipos de desarrollo)**

- Integran el servicio de auth en sus aplicaciones
- Necesitan: documentación, SDK, ejemplos de código, webhooks

**DevOps/Infraestructura**

- Mantienen y monitorean el servicio
- Monitoreo, logs, alertas, backups, escalado

### Casos de Uso Principales

1. **Registrarse en una nueva app**
   - Usuario llena email + password + datos básicos en App 1 (Blog)
   - Recibe email de confirmación (enviado por Auth)
   - Accede a Blog con sus credenciales
   - NOTA: Este usuario existe SOLO en Blog, no automáticamente en Tienda
2. **Login en múltiples apps**
   - Mismo usuario (juan@example.com) decide usar App 2 (Tienda)
   - Tienda lo ve como usuario NUEVO (su tabla de usuarios no lo conoce)
   - Se registra nuevamente con mismo email (permitido, es otra app)
   - Tienda crea su propio user record para juan@example.com
   - Ambas apps usan Auth para JWT, pero mantienen usuarios separados
3. **Recuperar contraseña olvidada**
   - Usuario pide reset
   - Recibe link por correo con token temporal
   - Crea nueva contraseña
4. **Cambiar contraseña**
   - Usuario logueado cambia su contraseña
   - Invalida todos los refresh tokens antiguos
5. **Integrar nueva aplicación**
   - Developer registra su app en el servicio
   - Obtiene API keys
   - Implementa login usando JWT
6. **Renovar token expirado**
   - JWT a punto de expirar
   - App usa refresh token para obtener nuevo JWT
   - Sin que el usuario tenga que loguearse nuevamente

## Funcionalidades Core

### MVP (Mínimo producto viable) - Fase 1

**Autenticación Básica**

- [x] Registro de usuarios (email + password)
- [x] Login (validar credenciales)
- [x] Generación de JWT con RS256
- [x] Validación de JWT
- [x] Logout (invalidar tokens)
- [x] Refresh token (renovación sin re-login)

**Gestión de Usuarios**

- [x] Perfil de usuario (ver datos)
- [x] Cambiar contraseña
- [x] Confirmación de email
- [x] Recuperación de contraseña (email + link con token)

**Notificaciones por Email**

- [x] Email de bienvenida al registrarse
- [x] Email de confirmación de cuenta
- [x] Email de reset de contraseña
- [x] Plantillas HTML personalizables

**APIs**

- [x] POST /auth/register
- [x] POST /auth/login
- [x] POST /auth/logout
- [x] POST /auth/refresh-token
- [x] GET /auth/me (perfil actual)
- [x] POST /auth/change-password
- [x] POST /auth/forgot-password
- [x] POST /auth/reset-password
- [x] POST /auth/verify-email

### Fase 2 - Mejoras

**Seguridad Avanzada**

- [ ] 2FA (autenticación de dos factores)
- [ ] Rate limiting en login
- [ ] Detección de intentos fallidos
- [ ] Bloqueo temporal de cuenta

**Integración**

- [ ] Webhooks (usuario creado, contraseña cambiada)
- [ ] OAuth (login con Google, GitHub)
- [ ] Botés sociales

**Monitoreo**

- [ ] Dashboard de estadísticas (logins, errores, usuarios)
- [ ] Alertas en tiempo real
- [ ] Logs auditables

### Fase 3 - Escalado

- [ ] Admin panel para gestionar usuarios
- [ ] Sesión múltiple por usuario
- [ ] Revocar tokens desde admin
- [ ] Políticas de contraseña personalizables

## Requisitos Funcionales Detallados

### ### REQ-F01: Registro de Usuario (Por Aplicación)

- Usuario proporciona: email, password, nombre
- Validaciones: Email único EN ESTA APP, password fuerte (min 8 chars, mayus/minus/números)
- Constraint: No puede haber dos usuarios con el mismo email EN LA MISMA APP
- El mismo email puede existir en diferentes apps, pero son usuarios independientes
- Respuesta: Crea usuario en la tabla de la app, envía email de confirmación (via Auth)
- Error: Email ya existe EN ESTA APP, formato inválido, password débil

### REQ-F02: Confirmación de Email

- Usuario recibe email con link + token temporal (válido 24h)
- Al hacer click: marca email como confirmado
- Sin confirmar: usuario no puede hacer login

### REQ-F03: Login

- Entrada: email + password
- Validación: Credenciales correctas
- Respuesta: JWT + refresh\_token
- JWT contiene: userId, email, roles\_globales, timestamp
- JWT vence en: 1 hora (configurable)
- Error: Email no existe, password incorrecto, email no confirmado

### REQ-F04: Refresh Token

- Entrada: refresh\_token
- Validación: Token válido, no expirado
- Respuesta: Nuevo JWT + nuevo refresh\_token
- Refresh vence en: 30 días (configurable)
- Error: Token inválido o expirado

### REQ-F05: Logout

- Entrada: JWT + refresh\_token
- Acción: Invalida el refresh\_token en BD
- Respuesta: 200 OK
- El JWT sigue siendo válido hasta expirar (JWT es stateless)

### REQ-F06: Recuperación de Contraseña

- Usuario solicita reset con su email
- Email válido: envía link con token temporal (válido 1h)
- Email inválido: no revela que el email no existe (por seguridad)
- Usuario hace click en link: formulario para nueva contraseña
- Nueva contraseña guardada: invalida todos los refresh\_tokens antiguos

### REQ-F07: Cambiar Contraseña

- Usuario logueado puede cambiar su contraseña
- Requiere: contraseña actual + nueva contraseña
- Validación: Contraseña actual correcta, nueva contraseña fuerte
- Acción: Invalida todos los refresh\_tokens (logout de todas las sesiones)

### REQ-F08: Perfil de Usuario

- GET /auth/me
- Retorna: userId, email, nombre, creado\_en
- Requiere: JWT válido

### REQ-F09: Validación de JWT

- Cada app valida JWT localmente con public key del servicio auth
- Si firma es válida: acepta el token
- Si firma es inválida o expirado: rechaza con 401
- No requiere llamada a auth en cada request

### REQ-F10: Transacción de Tokens

- El servicio mantiene en BD:
  - users (id, email, password\_hash, nombre, email\_confirmado, creado\_en)
  - refresh\_tokens (id, user\_id, token, expires\_at)
- Al cambiar contraseña: DELETE todos los refresh\_tokens del usuario

## Requisitos No-Funcionales

### Performance

- **Latencia de login:** < 500ms P95
- **Latencia de validación JWT:** < 10ms (local, sin BD)
- **Throughput:** Soportar 1000 requests/segundo
- **Tiempo de respuesta refresh token:** < 200ms
- **Caché:** JWT y claves públicas cacheadas en apps consumidoras

### Disponibilidad

- **Uptime objetivo:** 99.9% (SLA)
- **RTO (Recovery Time):** < 5 minutos
- **RPO (Recovery Point):** < 1 minuto
- **Monitoreo:** Alertas en tiempo real para outages

### Escalabilidad

- **Horizontal scaling:** Múltiples instancias del servicio
- **Load balancer:** Distribuir tráfico entre instancias
- **BD:** Replicación para redundancia
- **Capacidad inicial:** 1M usuarios activos

### Seguridad

- **Almacenamiento de passwords:** Bcrypt con salt (min 12 rounds)
- **Comunicación:** HTTPS/TLS 1.2+ (obligatorio)
- **JWT firma:** RS256 (asymmetric, no HS256)
- **Expiración tokens:** JWT 1h, refresh 30 días
- **Rate limiting:** Máx 5 intentos de login fallidos / 15 min por IP
- **CORS:** Whitelist de dominios permitidos
- **Secrets:** Almacenar en vault (no en código)
- **Logs:** No registrar passwords ni tokens sensibles
- **OWASP:** Cumplir top 10

### Confiabilidad

- **Error rate:** < 0.1% en operaciones
- **Retry logic:** Reintentos exponenciales en fallos transitorios
- **Circuit breaker:** Para llamadas externas (email, etc)
- **Health checks:** Endpoint /health cada 30 segundos

### Mantenibilidad

- **Código:** Bien documentado, comentarios explicativos
- **Testing:** Unit tests, integration tests, e2e tests
- **CI/CD:** Automated tests antes de deploy
- **Versionado:** Semantic versioning (MAJOR.MINOR.PATCH)
- **Documentación:** OpenAPI/Swagger spec completo
- **Rollback:** Plan para deshacer deploys si es necesario

### Compatibilidad

- **API versioning:** /v1/auth/login, /v2/auth/login (en el futuro)
- **Backward compatibility:** No romper APIs existentes sin versioning
- **Lenguajes:** SDKs para Node.js, Python, Go, etc

### Compliance & Auditoría

- **GDPR:** Derecho al olvido, exportación de datos
- **Logs de auditoría:** Qué usuario hizo qué y cuándo
- **Retención de logs:** 90 días mínimo
- **Encriptación en reposo:** BD encriptada

### Usabilidad

- **Tiempo para integrar nueva app:** < 2 horas (con docs)
- **Documentación clara:** Ejemplos de código en múltiples lenguajes
- **Errores descriptivos:** Mensajes de error útiles para debugging

## Arquitectura Técnica

### Stack Definido (NestJS)

**Backend**

- **Runtime:** Node.js v24.21.0 LTS
- **Framework:** NestJS (TypeScript)
- **BD Principal:** PostgreSQL 14+ (users\_auth, refresh\_tokens, email\_confirmations, password\_resets)
- **ORM:** TypeORM o Prisma
- **Cache:** Redis (rate limiting, refresh tokens)
- **Email:** SendGrid o AWS SES
- **Secrets:** HashiCorp Vault o AWS Secrets Manager
- **JWT:** @nestjs/jwt + jsonwebtoken
- **Validación:** class-validator + class-transformer
- **Logging:** Winston o Pino

**Autenticación & JWT**

- **Algoritmo:** RS256 (RSA 2048 bits)
- **Librerías:** jsonwebtoken (Node) o PyJWT (Python)
- **Almacenamiento de keys:** Vault
  - Private key: servidor auth solo
  - Public key: distribuir a todas las apps

**Infraestructura**

- **Hosting:** AWS EC2 / Google Cloud Run / Azure App Service
- **Load Balancer:** AWS ALB / Google Cloud Load Balancer
- **Monitoring:** Prometheus + Grafana (o DataDog)
- **Logs:** ELK Stack o CloudWatch
- **CI/CD:** GitHub Actions / GitLab CI

### Esquema de BD

-- BD DEL SERVICIO AUTH (centralizada) -- Solo maneja tokens y validación, NO usuarios

TABLE users\_auth ( id UUID PRIMARY KEY, email VARCHAR UNIQUE NOT NULL, password\_hash VARCHAR NOT NULL, creado\_en TIMESTAMP DEFAULT NOW(), actualizado\_en TIMESTAMP DEFAULT NOW(), INDEX (email) )

TABLE refresh\_tokens ( id UUID PRIMARY KEY, user\_id UUID FOREIGN KEY users\_auth(id), token VARCHAR UNIQUE NOT NULL, expires\_at TIMESTAMP NOT NULL, creado\_en TIMESTAMP DEFAULT NOW(), INDEX (user\_id, expires\_at) )

TABLE email\_confirmations ( id UUID PRIMARY KEY, user\_id UUID FOREIGN KEY users\_auth(id), token VARCHAR UNIQUE NOT NULL, expires\_at TIMESTAMP NOT NULL, app\_name VARCHAR NOT NULL, creado\_en TIMESTAMP DEFAULT NOW() )

TABLE password\_resets ( id UUID PRIMARY KEY, user\_id UUID FOREIGN KEY users\_auth(id), token VARCHAR UNIQUE NOT NULL, expires\_at TIMESTAMP NOT NULL, app\_name VARCHAR NOT NULL, creado\_en TIMESTAMP DEFAULT NOW() )

-- BD DE APP 1 (BLOG) - cada app tiene la suya TABLE users\_blog ( id UUID PRIMARY KEY, email VARCHAR UNIQUE NOT NULL, nombre VARCHAR NOT NULL, role VARCHAR DEFAULT 'viewer', creado\_en TIMESTAMP DEFAULT NOW(), INDEX (email) )

-- BD DE APP 2 (TIENDA) - completamente independiente TABLE users\_tienda ( id UUID PRIMARY KEY, email VARCHAR UNIQUE NOT NULL, nombre VARCHAR NOT NULL, role VARCHAR DEFAULT 'buyer', creado\_en TIMESTAMP DEFAULT NOW(), INDEX (email) )

-- NOTA: El email juan@example.com puede existir en users\_auth -- (para el login), y también en users\_blog y users\_tienda -- como tres registros completamente independientes

### Flujo de Autenticación

Flujo: Usuario intenta hacer login en APP 1 (Blog)

1. Usuario en APP 1 (Blog) hace POST /login {email, password} ↓
2. APP 1 verifica si el usuario existe EN SU BD (users\_blog) ↓
3. Si NO existe en Blog:
   - Blog rechaza con 401 "User not found in this app"
   - Usuario debe registrarse primero en Blog ↓
4. Si existe en Blog:
   - Blog llama a AUTH: POST /auth/login {email, password} ↓
5. AUTH valida credenciales en users\_auth
   - Si válido: Genera JWT (RS256, vence 1h)
   - Genera refresh\_token (guardar en BD de Auth)
   - Retorna {access\_token, refresh\_token, expires\_in} ↓
6. Blog retorna tokens al usuario ↓
7. En siguientes requests:
   - Usuario envía JWT en Authorization header
   - Blog valida JWT localmente (firma)
   - Si válido: Blog procesa la solicitud
   - Si expirado: Usuario usa refresh\_token

NOTA: Un usuario que se registra en Blog NO aparece automáticamente en Tienda. Si intenta login en Tienda con el mismo email, Tienda lo ve como nuevo usuario.

### APIs del Servicio Auth

```
POST /v1/auth/register
  Body: {email, password, nombre}
  Response: {user_id, email}
  
POST /v1/auth/login
  Body: {email, password}
  Response: {access_token, refresh_token, expires_in}
  
POST /v1/auth/refresh-token
  Body: {refresh_token}
  Response: {access_token, refresh_token, expires_in}
  
POST /v1/auth/logout
  Body: {refresh_token}
  Response: {success: true}
  
GET /v1/auth/me
  Headers: Authorization: Bearer <JWT>
  Response: {id, email, nombre, creado_en}
  
POST /v1/auth/change-password
  Headers: Authorization: Bearer <JWT>
  Body: {current_password, new_password}
  Response: {success: true}
  
POST /v1/auth/forgot-password
  Body: {email}
  Response: {message: "Check your email"}
  
POST /v1/auth/reset-password
  Body: {token, new_password}
  Response: {success: true}
  
POST /v1/auth/verify-email
  Body: {token}
  Response: {success: true}
  
GET /health
  Response: {status: "ok", uptime: 12345}
```

## Consideraciones de Seguridad y Compliance

### OWASP Top 10 Mitigación

**A01: Broken Access Control**

- JWT con firma RS256 (no se puede forjar sin private key)
- Validación en cada request
- Refresh tokens con expirador corto (30d)

**A02: Cryptographic Failures**

- Passwords: Bcrypt (12+ rounds) + salt
- En tránsito: HTTPS/TLS 1.2+ obligatorio
- En reposo: BD encriptada
- JWT: RS256 (RSA 2048 bits)

**A03: Injection**

- Prepared statements en todas las queries
- Input validation en todos los endpoints
- No interpolar variables en SQL

**A04: Insecure Design**

- Rate limiting: 5 intentos de login fallidos / 15min
- JWT con vencimiento corto
- Logout invalida refresh\_tokens
- Cambio de contraseña invalida todas las sesiones

**A05: Broken Authentication**

- Password strong (min 8 chars, mayus, minus, números)
- Email confirmation requerido
- Refresh token rotation en cada renovación
- No guardar passwords en logs

**A06: Sensitive Data Exposure**

- No exponemos user IDs internos en URLs
- Tokens en memoria, no en logs
- Borrar datos sensibles después de usar
- No retornar password\_hash en respuestas

**A07: Cross-Origin Resource Sharing (CORS)**

- Whitelist de dominios permitidos
- No usar wildcard "\*" en producción
- Validar Origin header

**A08: Software and Data Integrity Failures**

- Verificar integridad de dependencias
- Actualizar paquetes regularmente
- Scanning de vulnerabilidades en CI/CD

**A09: Logging and Monitoring Failures**

- Logs auditables: quién hizo qué y cuándo
- Alertas en intentos fallidos múltiples
- Monitoreo de uptime del servicio
- No loguear passwords ni tokens

**A10: Server-Side Request Forgery (SSRF)**

- Validar URLs de webhooks
- No permitir IPs locales/privadas
- Timeouts en peticiones HTTP

### Compliance & Regulaciones

**GDPR (General Data Protection Regulation)**

- Derecho al olvido: endpoint para eliminar usuario
- Portabilidad de datos: export en formato JSON
- Consentimiento: requerir antes de procesar datos
- DPO (Data Protection Officer) designado
- Notificación de brechas dentro de 72h

**SOC 2 Type II**

- Auditoría anual
- Controles de acceso documentados
- Logs de auditoría por 90 días
- Incident response plan

**HIPAA (si aplica a aplicaciones de salud)**

- Encriptación de datos de salud
- Access logs
- Breach notification

### Seguridad Operacional

**Secrets Management**

- Private key del JWT en Vault (no en repo)
- API keys en Vault o AWS Secrets Manager
- Rotación de secrets cada 3 meses
- Diferentes secrets por env (dev, staging, prod)

**Access Control**

- Minimum privilege principle
- MFA para acceso a producción
- Sudo logs para acciones sensibles
- SSH keys (no passwords) para servidores

**Incident Response**

- Plan de respuesta documentado
- Contactos de escalación
- Postmortem después de incidentes
- Backup & restore tested mensualmente

**Penetration Testing**

- Pentest anual con terceros
- Fix de vulnerabilidades dentro de 30d
- Reporte público (responsable disclosure)

### Encriptación de Datos

**En tránsito**

- HTTPS/TLS 1.2+ obligatorio
- Certificado SSL valido (no self-signed)
- HSTS header activado

**En reposo**

- BD encriptada (TDE - Transparent Data Encryption)
- Backups encriptados
- Disco del servidor encriptado

**Passwords**

- Nunca hash reversible (bcrypt, no md5 o sha1)
- Nunca plaintext en logs
- Salt generado aleatoriamente (bcrypt lo hace)

### Pruebas de Seguridad

- Unit tests: validación de inputs
- Integration tests: flujo completo de auth
- Security tests: inyección, XSS, CSRF
- Load tests: resistencia a DoS
- Fuzzing: entrada aleatoria para encontrar crashes

## Roadmap y Fases de Implementación

### Fase 1: MVP (Semanas 1-4)

**Objetivo:** Lanzar auth básico que permita login, registro y refresh tokens

- **Semana 1:** Setup infraestructura + BD
  - [ ] Configurar PostgreSQL
  - [ ] Configurar Redis
  - [ ] Vault para secrets
  - [ ] CI/CD pipeline básico
- **Semana 2:** Core auth
  - [ ] Endpoints /register, /login, /logout
  - [ ] Generación de JWT (RS256)
  - [ ] Bcrypt password hashing
  - [ ] Unit tests
- **Semana 3:** Email + Validaciones
  - [ ] Integración con SendGrid/SES
  - [ ] Email confirmación
  - [ ] Recover password
  - [ ] Input validation
- **Semana 4:** Documentación + Deploy
  - [ ] OpenAPI spec
  - [ ] README y ejemplos
  - [ ] Deploy a staging
  - [ ] Load testing

**Entregable:** Servicio auth en producción con 1 app integrada

### Fase 2: Seguridad y Escalabilidad (Semanas 5-7)

**Objetivo:** Mejorar seguridad, monitoring y hacer robusto para más apps

- **Semana 5:** Seguridad avanzada
  - [ ] Rate limiting
  - [ ] CORS whitelist
  - [ ] Audit logs
  - [ ] HTTPS + HSTS
  - [ ] Security tests
- **Semana 6:** Monitoring
  - [ ] Prometheus metrics
  - [ ] Grafana dashboards
  - [ ] Alertas
  - [ ] Health endpoint
  - [ ] Incident runbook
- **Semana 7:** Integraciones de apps
  - [ ] Integrar App 2 (Tienda)
  - [ ] Integrar App 3 (Panel)
  - [ ] Testing e2e
  - [ ] Documentación de SDK

**Entregable:** 3 apps integradas, sistema estable, 99.9% uptime

### Fase 3: Mejoras y 2FA (Semanas 8-10)

**Objetivo:** Agregar seguridad avanzada, webhooks, admin panel

- **Semana 8:** 2FA
  - [ ] TOTP (Time-based OTP)
  - [ ] Backup codes
  - [ ] SMS opcional
- **Semana 9:** Webhooks + Admin
  - [ ] Webhooks para eventos (user created, password changed)
  - [ ] Panel admin básico
  - [ ] Gestión de usuarios desde admin
- **Semana 10:** Optimizaciones
  - [ ] Caching de JWKs
  - [ ] Query optimization
  - [ ] Batch operations
  - [ ] Performance testing

**Entregable:** Auth con 2FA, webhooks, admin panel

### Fase 4: Escalado Futuro (Roadmap)

**OAuth 2.0 / OpenID Connect**

- Login con Google, GitHub, etc

**Multi-tenancy**

- Si varias orgánicas usan el auth

**Session Management**

- Múltiples sesiones activas por usuario
- Revocar sesiones desde admin

**Advanced Compliance**

- SOC 2 certification
- HIPAA si aplica

### Timeline Visual

```
Oct 2024        Fase 1 (MVP)    |    Fase 2 (Seg)     |  Fase 3 (2FA)
                W1  W2  W3  W4  |  W5  W6  W7  W8  W9  W10 W11
                |---|---|---|---|  |---|---|---|---|---|---|
                \___MVP___/       \______Stable____/
                                  \__Monitoring__/
                                            \___3 apps___/
```

### Criterios de Exitoso por Fase

**Fase 1 - MVP:**

- ✓ Login/register funciona
- ✓ Emails se envían
- ✓ JWT valida en apps
- ✓ 1 app integrada

**Fase 2 - Estable:**

- ✓ 99.9% uptime por 2 semanas
- ✓ 3 apps integradas
- ✓ Latencia < 500ms P95
- ✓ Rate limiting funciona

**Fase 3 - Avanzada:**

- ✓ 2FA funcional
- ✓ Webhooks entregados
- ✓ Admin panel usable
- ✓ 5 apps integrando

## Criterios de Éxito y Métricas

### Métricas Técnicas

| Métrica | Método | Target | Frecuencia |
| --- | --- | --- | --- |
| **Uptime** | Monitoreo Prometheus | 99.9% | Diario |
| **Latencia P95** | APM (DataDog/New Relic) | < 500ms | Cada request |
| **Error Rate** | Logs + alertas | < 0.1% | Cada minuto |
| **Throughput** | Load testing | ≥ 1000 req/s | Semanal |
| **JWT Validation** | Benchmark local | < 10ms | Cada semana |
| **DB Query Time** | Slow query logs | < 100ms | Diario |
| **SSL/TLS Score** | Qualys SSL Labs | A+ | Mensual |

### Métricas de Adopción

| Métrica | Target | Timeline |
| --- | --- | --- |
| **Apps Integradas** | 3+ | Semana 7 |
| **Usuarios Registrados** | 100+ | Semana 4 |
| **Usuarios Activos (MAU)** | 500+ | Semana 8 |
| **Logins por Día** | 1000+ | Semana 10 |
| **Email Delivery Rate** | > 99% | Contino |

### Métricas de Seguridad

| Métrica | Target | Verificación |
| --- | --- | --- |
| **Vulnerabilidades Críticas** | 0 | Pentest anual |
| **Brechas de Datos** | 0 | Monitoring 24/7 |
| **OWASP Top 10 Compliance** | 100% | Code review |
| **Password Reset Rate** | < 5% usuarios/mes | Logs |
| **Failed Login Attempts Bloqueados** | > 95% | Rate limiter |
| **API Key Rotation** | Cada 90días | Checklist |

### Métricas de Experiencia del Desarrollador

| Métrica | Target | Método |
| --- | --- | --- |
| **Tiempo de integración** | < 2 horas | Prueba con nuevo developer |
| **Satisfacción (NPS)** | ≥ 70 | Encuesta trimestral |
| **Documentación Completitud** | 100% | Checklist vs APIs |
| **Support Response Time** | < 4 horas | SLA monitoreo |
| **SDK Disponibles** | Node, Python, Go | Roadmap |

### KPIs de Negocio

| KPI | Target | Impacto |
| --- | --- | --- |
| **Costo por Usuario (opex)** | < $0.01/usuario/año | Reduce duplicación |
| **Tiempo de mercado para nueva app** | 2 horas vs 1 semana | Acelera desarrollo |
| **Reducción de bugs de seguridad** | -80% | Menos vulnerabilidades |
| **% de apps usando auth central** | 100% | Evita fragmentación |

### Dashboard de Monitoreo (Grafana)

```
Paneles principales:
- Uptime (gauge 0-100%)
- Requests por segundo (line chart)
- Latencia P50/P95/P99 (line chart)
- Error rate por endpoint (bar chart)
- Usuarios activos (gauge)
- Emails enviados (counter)
- Failed logins bloqueados (counter)
- Vulnerabilidades conocidas (number)
```

### Herramientas Recomendadas

**Monitoring**

- Prometheus (métricas)
- Grafana (visualización)
- AlertManager (alertas)

**Logs**

- ELK Stack (Elasticsearch, Logstash, Kibana)
- O CloudWatch si AWS

**APM (Application Performance)**

- DataDog
- New Relic
- Jaeger

**Seguridad**

- Snyk (scanning de dependencias)
- OWASP ZAP (testing)
- Qualys (SSL assessment)

**Load Testing**

- k6
- JMeter
- Locust

### Revisiones y Ajustes

- **Weekly:** Uptime, latencia, error rate
- **Monthly:** Adopción, seguridad, NPS
- **Quarterly:** Strategic review, roadmap update
- **Annually:** Pentest, security audit
