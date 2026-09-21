Actúa como un arquitecto de software backend Senior experto en redes e ISPs. Necesito que diseñes e implementes la especificación completa y el código base para una API RESTful en JSON que será consumida por un Agente de Inteligencia Artificial (vía Function Calling/LLM Tools).

### Requisitos Técnicos Globales:
1. Autenticación: Todas las peticiones deben requerir un header `Authorization: Bearer <API_KEY>`.
2. Formato de Respuesta de Error Estándar:
   {
     "status": "error",
     "code": "CODIGO_ERROR",
     "message": "Descripción amigable para que la IA se la transmita al usuario"
   }
3. Seguridad: Sanitizar entradas, manejar códigos de estado HTTP correctos (200, 400, 401, 404, 500) y validar tipos de datos.

Por favor, genera la especificación OpenAPI (Swagger) y/o el código de implementación para los siguientes 8 endpoints estructurados por módulos:

---

### MÓDULO 1: PAGOS Y FACTURACIÓN

1. Consulta de Deuda
- Endpoint: GET /api/v1/cliente/consultar-deuda
- Propósito: Permite a la IA saber si el cliente tiene facturas vencidas y cuánto debe.
- Query Parameters: `telefono` (string, ej: "+593991234567") O `cedula` (string).
- Respuesta Exitosa (200 OK):
  {
    "status": "success",
    "cliente": {
      "id": 1042,
      "nombre": "Jefferson Oña",
      "estado_servicio": "SUSPENDIDO_POR_CORTE",
      "ip_asignada": "192.168.10.45"
    },
    "deuda_total": 10.00,
    "facturas_pendientes": [
      {
        "factura_id": 9841,
        "mes": "Agosto 2026",
        "monto": 10.00,
        "fecha_vencimiento": "2026-08-15"
      }
    ]
  }

2. Registro y Validación de Pago
- Endpoint: POST /api/v1/pagos/registrar
- Propósito: Recibir los datos del comprobante procesado por la IA (QR/OCR), registrar la transacción en la base de datos y disparar la orden de desbloqueo en el MikroTik.
- Body (JSON):
  {
    "cliente_id": 1042,
    "monto": 10.00,
    "banco_origen": "Banco Pichincha",
    "num_comprobante": "92947292",
    "uuid_transaccion": "65702911-c699-4ac3-84e1-25f653fe9900",
    "hash_qr": "9aa587037b5c4441ffcff621f722c7e1...",
    "fecha_transaccion": "2026-08-17 05:00:00",
    "origen": "BOT_WHATSAPP"
  }
- Respuesta Exitosa (200 OK):
  {
    "status": "success",
    "mensaje": "Pago registrado y servicio restablecido.",
    "transaccion_id": "PAG-90812",
    "saldo_restante": 0.00
  }

---

### MÓDULO 2: VENTAS Y CAPTACIÓN

3. Validar Cobertura Técnica
- Endpoint: POST /api/v1/ventas/validar-cobertura
- Propósito: Recibir las coordenadas GPS enviadas por un prospecto y calcular la cercanía a una caja NAP.
- Body (JSON):
  {
    "latitud": -0.180653,
    "longitud": -78.467838
  }
- Respuesta Exitosa (200 OK):
  {
    "status": "success",
    "tiene_cobertura": true,
    "caja_nap_cercana": "NAP-NORTE-04",
    "distancia_metros": 45
  }

4. Obtener Catalogo de Planes
- Endpoint: GET /api/v1/ventas/planes
- Propósito: Retornar los planes comerciales activos para ofrecer al prospecto.
- Respuesta Exitosa (200 OK):
  {
    "planes": [
      {"id": 1, "nombre": "Plan Hogar Fibra", "velocidad": "200 Mbps", "precio": 20.00},
      {"id": 2, "nombre": "Plan Gamer Pro", "velocidad": "400 Mbps", "precio": 30.00}
    ]
  }

5. Agendar Instalación / Crear Contrato
- Endpoint: POST /api/v1/ventas/agendar-instalacion
- Propósito: Guardar los datos del nuevo cliente y separar el cupo de instalación en el calendario del equipo técnico.
- Body (JSON):
  {
    "prospecto": {
      "nombre": "Carmen Velez",
      "cedula": "1300000000",
      "telefono": "+593987654321",
      "direccion": "Av. Amazonas y Colón",
      "coordenadas": "-0.180653, -78.467838"
    },
    "plan_id": 2,
    "fecha_programada": "2026-08-21",
    "franja_horaria": "10:00 - 12:00"
  }
- Respuesta Exitosa (201 Created):
  {
    "status": "success",
    "mensaje": "Instalación agendada correctamente.",
    "orden_instalacion_id": "INS-4029"
  }

---

### MÓDULO 3: SOPORTE TÉCNICO Y AUTOGESTIÓN

6. Crear Ticket de Incidencia
- Endpoint: POST /api/v1/soporte/crear-ticket
- Propósito: Generar una orden de soporte cuando la IA determine que requiere intervención técnica humana.
- Body (JSON):
  {
    "cliente_id": 1042,
    "tipo_incidencia": "SIN_SERVICIO_LUZ_ROJA",
    "descripcion_bot": "El cliente indica que la ONT tiene la luz LOS parpadeando en rojo.",
    "prioridad": "ALTA",
    "adjunto_url": "https://midominio.com/uploads/foto_los.jpg"
  }
- Respuesta Exitosa (201 Created):
  {
    "status": "success",
    "ticket_id": "TK-8821",
    "mensaje": "Ticket creado exitosamente y asignado a cuadrilla técnica."
  }

7. Diagnóstico en Vivo de ONT
- Endpoint: GET /api/v1/red/diagnostico-ont
- Propósito: Realizar una consulta en tiempo real del estado de potencia óptica y visibilidad del equipo del cliente.
- Query Parameters: `cliente_id` (int).
- Respuesta Exitosa (200 OK):
  {
    "status": "success",
    "estado_ont": "ONLINE",
    "potencia_rx": "-21.5 dBm",
    "es_potencia_optima": true,
    "falla_masiva_sector": false
  }

8. Cambiar Credenciales Wi-Fi
- Endpoint: POST /api/v1/red/cambiar-wifi
- Propósito: Enviar la instrucción al router/ONT del usuario para actualizar el SSID y la contraseña.
- Body (JSON):
  {
    "cliente_id": 1042,
    "nuevo_ssid": "MiRedFibra_5G",
    "nueva_clave": "Seguridad2026*"
  }
- Respuesta Exitosa (200 OK):
  {
    "status": "success",
    "mensaje": "Credenciales Wi-Fi actualizadas en el equipo remoto."
  }

---

Escribe el código estructurado (en el lenguaje/framework que prefieras, ej: Node.js/Express, Python/FastAPI, o Laravel) para exponer estos controladores con las validaciones requeridas.