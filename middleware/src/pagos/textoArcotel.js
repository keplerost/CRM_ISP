/**
 * El texto del modelo de contrato de adhesión inscrito en la ARCOTEL.
 *
 * ── Por qué esto es código y no una plantilla editable ──
 *
 * Porque no lo redacta el ISP. Es un modelo que se inscribe ante el regulador y
 * que lleva su fecha de inscripción impresa al pie; lo que cambia entre un
 * abonado y otro son los datos y las casillas marcadas, no las cláusulas.
 *
 * Es la misma situación del RIDE con el SRI: un contrato que dijera algo
 * distinto del modelo inscrito es un problema regulatorio, no una diferencia de
 * presentación. Ponerlo en el editor de plantillas invitaría a cambiarlo, y el
 * ISP que cambiara una cláusula quedaría firmando contratos que no corresponden
 * a lo que inscribió.
 *
 * Lo que SÍ es propio de cada ISP —razón social, RUC, domicilio, canales de
 * reclamo, tarifas, plazos, fecha de inscripción de SU modelo— vive en la tabla
 * `prestadores` y entra acá como variables.
 *
 * ── Cómo se lee ──
 *
 * `{{marcador}}` se reemplaza con los datos. Las casillas se declaran aparte
 * porque no son texto: son cuadros que se marcan o no, y el dibujo necesita
 * saber cuál va marcado.
 */

/** Los servicios de la cláusula segunda. Se marca el que se contrata. */
export const SERVICIOS = [
  'MOVIL AVANZADO (SMA)',
  'MOVIL AVANZADO A TRAVES DE OPERADOR MOVIL VIRTUAL (OMV)',
  'TELEFONÍA FIJA',
  'TELECOMUNICACIONES POR SATÉLITE',
  'VALOR AGREGADO',
  'SERVICIO DE ACCESO A INTERNET',
  'TRONCALIZADOS',
  'COMUNALES',
  'AUDIO Y VIDEO POR SUSCRIPCION',
  'PORTADOR',
]

/** El que presta este sistema. El resto va en blanco. */
export const SERVICIO_CONTRATADO = 'SERVICIO DE ACCESO A INTERNET'

/** Las formas de pago de la cláusula sexta. */
export const FORMAS_PAGO = [
  'Pago directo en cajas del Prestador del servicio',
  'Pago en ventanilla de locales autorizados',
  'Débito automático cuenta de ahorro o corriente',
  'Débito con tarjeta de crédito',
  'Transferencia vía medios electrónicos',
  'Otros',
]

/**
 * Las cláusulas, en orden.
 *
 * `condicion` marca las que además de texto llevan una casilla que responder;
 * el dibujo la resuelve con los datos del abonado.
 */
export const CLAUSULAS = [
  {
    n: 'CLÁUSULA SEGUNDA',
    titulo: 'Objeto',
    texto:
      'El Prestador del servicio se compromete a proporcionar al Abonado el/los siguiente(s) '
      + 'servicio(s), para lo cual el Prestador dispone de los correspondientes títulos '
      + 'habilitantes otorgados por la ARCOTEL, de conformidad con el ordenamiento jurídico '
      + 'vigente:',
    bloque: 'servicios',
    cierre:
      'Las Condiciones Técnicas del/los servicio(s) que el Abonado va a contratar se encuentran '
      + 'detalladas en el Anexo N° 1f, el cual forma parte integrante del presente contrato.',
  },
  {
    n: 'CLÁUSULA TERCERA',
    titulo: 'Anexos',
    texto:
      'Es parte integrante del presente CONTRATO el Anexo 1 que contiene las "Condiciones '
      + 'particulares del Servicio". El Anexo 2 "Aceptación de uso de datos personales". El '
      + 'Anexo 3 "Compra o arrendamiento de Equipos". Acta de Entrega/Instalación.',
  },
  {
    n: 'CLÁUSULA CUARTA',
    titulo: 'Vigencia del Contrato',
    texto:
      'El presente contrato tendrá una duración de {{vigencia}} y entrará en vigencia, a partir '
      + 'de la fecha de instalación y prestación efectiva del servicio. La fecha inicial '
      + 'considerada para facturación para cada uno de los servicios contratados debe ser la de '
      + 'la activación de servicio. Las partes se comprometen a respetar el plazo de vigencia '
      + 'pactado. El Abonado acepta la renovación automática sucesiva del contrato en las mismas '
      + 'condiciones de este contrato, independientemente de su derecho a terminar la relación '
      + 'contractual conforme la legislación aplicable, o solicitar en cualquier tiempo, con '
      + 'hasta quince (15) días de antelación a la fecha de renovación, su decisión de no '
      + 'renovación:',
    condicion: 'renovacion_automatica',
    cierre:
      'Cuando un contrato contemple renovación automática como una de sus condiciones, ésta será '
      + 'notificada por el prestador con quince (15) días de anticipación a su renovación a los '
      + 'medios de contacto registrados por el usuario. Para la renovación no se podrán exigir '
      + 'requisitos adicionales a los previamente solicitados al momento de la contratación '
      + 'inicial.',
  },
  {
    n: 'CLÁUSULA QUINTA',
    titulo: 'Permanencia mínima',
    /**
     * La pregunta lleva la permanencia que el ISP OFRECE, no la pactada.
     *
     * Es una pregunta: si llevara el resultado, al que no se acoge le diría
     * "¿se acoge al periodo de permanencia mínima de 0 meses?".
     */
    texto:
      '¿El Abonado se acoge al periodo de permanencia mínima de {{permanencia_ofrecida}} en la '
      + 'prestación del servicio contratado?',
    condicion: 'permanencia',
    lista: { titulo: 'Los beneficios de la permanencia mínima son:', campo: 'beneficios' },
    cierre:
      'La permanencia mínima se acuerda, sin perjuicio de que el abonado/suscriptor conforme lo '
      + 'determina la Ley Orgánica de Telecomunicaciones, pueda dar por terminado el contrato en '
      + 'forma unilateral y anticipada, y en cualquier tiempo previa notificación por medios '
      + 'físicos, telefónicos o electrónicos al prestador, con por lo menos (15) días calendario '
      + 'de anticipación. El contrato terminará quince (15) días calendario posteriores a la '
      + 'fecha de presentación de la solicitud.',
  },
  {
    n: 'CLÁUSULA SEXTA',
    titulo: 'Tarifa y forma de pago',
    texto:
      'Las tarifas o valores mensuales a ser cancelados por cada uno de los servicios contratados '
      + 'por el Abonado estará determinada en la ficha de cada servicio, que constan en el Anexo '
      + '1f y el pago se realizará, de la siguiente forma:',
    bloque: 'formas_pago',
    cierre:
      'La tarifa correspondiente al servicio contratado y efectivamente prestado estará dentro de '
      + 'los techos tarifarios señalados por la ARCOTEL y en los títulos habilitantes '
      + 'correspondientes, en caso de que se establezcan, de conformidad con el ordenamiento '
      + 'jurídico vigente. En caso de que el Abonado desee cambiar su modalidad de pago a otra de '
      + 'las disponibles, deberá comunicar al Prestador del servicio con quince (15) días de '
      + 'anticipación. El Prestador del servicio, luego de haber sido comunicado, instrumentará '
      + 'la nueva forma de pago. Cuando las actividades de recaudación se realicen directamente '
      + 'con el personal, infraestructura, aplicativos y desarrollos tecnológicos propios de la '
      + 'prestadora, ésta no podrá cobrar valor alguno al abonado, suscriptor o cliente por '
      + 'comisión de servicios y no aplica en caso de coactiva.',
  },
  {
    n: 'CLÁUSULA SEPTIMA',
    titulo: 'Instalación',
    numerales: [
      '7.1 Todos los equipos con que se prestan EL SERVICIO son de propiedad de EL Prestador. El '
      + 'Abonado los tiene en calidad de custodio, por tal motivo es su obligación velar por '
      + 'ellos y cuidar que se conserven en buen estado. Sin perjuicio de su responsabilidad.',
      '7.2 Si en las fechas establecidas de común acuerdo no pudieran llevarse a cabo las '
      + 'actividades programadas para la instalación y puesta en marcha del SERVICIO por causas '
      + 'atribuibles al Abonado, esta se reprogramará conforme la disponibilidad de trabajos del '
      + 'Prestador.',
      '7.3 Realizada la instalación del SERVICIO, El Prestador levantará un Acta de '
      + 'entrega/instalación del o de los servicios y le notificará al Abonado.',
      '7.4 Si EL Abonado introduce cambios que varíen el diseño físico, mecánico o eléctrico de '
      + 'los equipos, El Prestador quedará facultado para interrumpir el servicio que involucre a '
      + 'la unidad afectada y retirar el equipo instalado. EL Abonado deberá responder por las '
      + 'consecuencias y daños que los cambios y/o la adición y/o modificación hayan ocasionado '
      + 'al Prestador, y el reembolso de todos los gastos que resulte necesario efectuar.',
      '7.5 Las modificaciones en los lugares de instalación o en las obras de infraestructura que '
      + 'se hagan necesarias para la instalación, serán realizadas por el Abonado conforme '
      + 'descripción del Prestador.',
    ],
  },
  {
    n: 'CLÁUSULA OCTAVA',
    titulo: 'Compra, Arrendamiento de Equipos',
    texto:
      'Adicional al servicio contratado, objeto de este contrato y sin que este sea requisito para '
      + 'la prestación del servicio, el Prestador entrega en calidad de arrendamiento o venta, '
      + 'equipos accesorios para ser usados con el servicio, conforme el detalle, especificaciones '
      + 'y precio que se describen en el ANEXO 3. Para equipos en arriendo, al momento de la '
      + 'entrega de los equipos o terminación del contrato se considerará el deterioro normal y '
      + 'depreciación de los mismos. En caso de terminación del contrato, cuando se trate de '
      + 'adquisición de los equipos el Abonado deberá cancelar únicamente las cuotas pendientes.',
    numerales: [
      '8.1 Mantenimiento o Reposición: Equipos de propiedad del Abonado: El servicio de '
      + 'mantenimiento de los equipos de propiedad del Abonado empleados en la prestación del '
      + 'servicio estará a cargo de su propietario y por lo tanto EL Prestador no está obligado a '
      + 'realizar mantenimiento o reposición, salvo el caso de obligaciones de garantía por venta '
      + 'de equipos previamente acordada por las partes.',
      '8.2 Mantenimiento o Reposición: Equipos de propiedad del Prestador entregados en calidad '
      + 'de arrendamiento: El servicio de mantenimiento no tendrá cargo alguno para el Abonado y '
      + 'contemplará toda reparación, ajuste, cambio de partes, reemplazo o reposición de los '
      + 'equipos cuyas fallas resulten por el uso normal y apropiado del mismo y de vicios en los '
      + 'equipos, sin perjuicio de las consecuencias previstas en EL CONTRATO para los casos de '
      + 'incumplimiento de las obligaciones por parte del Abonado, respecto al buen uso, cuidado '
      + 'de los equipos y cumplimiento de las obligaciones relacionadas al canon de arrendamiento '
      + 'y devolución al finalizar el período de servicio.',
      '8.3 Mantenimiento o Reposición: Equipos de propiedad de EL Prestador entregados en calidad '
      + 'de préstamos: El servicio de mantenimiento no tendrá cargo alguno para el Abonado y '
      + 'contemplará toda reparación, ajuste, cambio de partes, reemplazo o reposición de los '
      + 'equipos cuyas fallas resulten por el uso normal y apropiado del mismo y de vicios en los '
      + 'equipos, sin perjuicio de las consecuencias previstas en EL CONTRATO, para los casos de '
      + 'incumplimiento de las obligaciones por parte del Abonado, respecto al buen uso, cuidado '
      + 'de los equipos entregados en custodia y devolución al finalizar el periodo de servicio.',
    ],
    cierre:
      'El prestador del servicio no podrá cobrar por el arrendamiento de equipos cuando estos '
      + 'sean parte fundamental e indispensable en la prestación del servicio. Únicamente lo '
      + 'podrá hacer cuando estos sean considerados equipos adicionales solicitados por el '
      + 'abonado, suscriptor o cliente. En los casos de renovación del contrato, el prestador '
      + 'propenderá al cambio del equipo, cuando este haya alcanzado la obsolescencia tecnológica '
      + 'que impida garantizar la calidad y las condiciones en la prestación del servicio '
      + 'contratado, sin costo adicional para el caso de los equipos que sean parte fundamental e '
      + 'indispensable en la prestación del servicio.',
  },
  {
    n: 'CLÁUSULA NOVENA',
    titulo: 'Uso de información personal',
    texto:
      'Los datos personales que los Abonados/Suscriptores proporcionen al Prestador de servicios '
      + 'del régimen general de telecomunicaciones, no podrán ser usados para la promoción '
      + 'comercial de servicios o productos, inclusive de la propia operadora; salvo autorización '
      + 'y consentimiento expreso del Abonado, el que constará como instrumento separado y '
      + 'distinto al presente contrato de prestación de servicios (contrato de adhesión) a través '
      + 'de medios físicos o electrónicos. En dicho instrumento se deberá dejar constancia '
      + 'expresa de los datos personales o información que están expresamente autorizados; el '
      + 'plazo de la autorización y el objetivo que esta utilización persigue, conforme lo '
      + 'dispuesto en el artículo 121 del Reglamento General a la Ley Orgánica de '
      + 'Telecomunicaciones. La autorización de uso de los datos personales e información aquí '
      + 'consignada para fines de promoción y comercial de los productos y servicios que la '
      + 'empresa oferta exclusivamente a sus Abonados/Suscriptores, así como para consultar y '
      + 'referir la información crediticia del Abonado, consta expresamente en el Anexo 2.',
    numerales: [
      'Privacidad y protección de datos personales.- El uso, tratamiento y protección de los '
      + 'datos personales debe regirse estrictamente por lo establecido en la Ley Orgánica de '
      + 'Protección de Datos Personales, su Reglamento General y las directrices emitidas por la '
      + 'Autoridad de Protección de Datos. Toda la información personal que se recopile, procese '
      + 'o almacene debe manejarse con total transparencia, seguridad y respeto a los derechos de '
      + 'los titulares de los datos. Se debe garantizar que los datos serán utilizados únicamente '
      + 'para los fines contractuales para la prestación del servicio y adicionalmente para los '
      + 'que el usuario ha dado su consentimiento explícito, informado, y siempre en cumplimiento '
      + 'con el marco legal vigente. Los datos contenidos en las guías telefónicas de telefonía '
      + 'fija se considerarán datos de fuentes accesibles al público. No obstante, los abonados '
      + 'tendrán derecho a que sus datos personales sean excluidos gratuitamente de dichas guías, '
      + 'a partir de su solicitud explícita y por cualquier mecanismo de atención disponible por '
      + 'el prestador.',
    ],
  },
  {
    n: 'CLÁUSULA DECIMA',
    titulo: 'Reclamos y soporte técnico',
    texto:
      'El Abonado podrá requerir soporte técnico o presentar reclamos al Prestador de servicios a '
      + 'través de los siguientes medios o puntos:',
    bloque: 'reclamos',
    cierre:
      'En el caso en que su queja, reclamo o solicitud no hayan sido resueltos por el prestador '
      + 'del servicio, en relación a la calidad del servicio prestado, a errores de facturación '
      + 'de los servicios, facturación de servicios no contratados, cobros indebidos, o en '
      + 'general por cualquier irregularidad que se hubiere producido en relación con el servicio '
      + 'contratado, los abonados, clientes o suscriptores podrán presentar las mismas a través '
      + 'de cualquiera de los siguientes canales de atención:',
    bloque_final: 'canales_arcotel',
  },
  {
    n: 'CLÁUSULA DECIMA PRIMERA',
    titulo: 'Normativa Aplicable',
    texto:
      'En la prestación del servicio, se entienden incluidos todos los derechos y obligaciones de '
      + 'los Abonados/Suscriptores, establecidos en las normas jurídicas aplicables, así como '
      + 'también los derechos y obligaciones de los Prestadores de servicios de telecomunicaciones '
      + 'y/o servicios de radiodifusión por suscripción, dispuestos en el marco regulatorio.',
  },
  {
    n: 'CLÁUSULA DECIMA SEGUNDA',
    titulo: 'Causales y Mecanismos de Terminación del contrato',
    texto:
      'Las partes acuerdan recíprocamente que EL CONTRATO se terminará por la ejecución total de '
      + 'las obligaciones derivadas del mismo; por acuerdo mutuo y que conste por escrito, o '
      + 'cuando ocurra alguna de las siguientes causales:',
    bloque: 'causales',
    cierre:
      'Los abonados, suscriptores o clientes tienen el derecho de terminar su contrato de manera '
      + 'anticipada y unilateral en cualquier momento, sin importar el plazo de vigencia '
      + 'establecido. Pueden hacerlo a través de cualquier medio físico, telefónico o '
      + 'electrónico, simplemente notificando al prestador su decisión con al menos quince (15) '
      + 'días calendario de anticipación a la finalización del periodo de facturación en curso. '
      + 'Esta terminación unilateral no generará multas, penalidades, recargos de valores o '
      + 'costos adicionales de ninguna naturaleza.',
    cierre2:
      'Los saldos pendientes de pago relacionados con cualquiera de los conceptos como, '
      + 'prestación del servicio, equipo terminal, condición de permanencia mínima, y la entrega '
      + 'cualquier equipo provisto al abonado, suscriptor o cliente, no podrán ser impedimento '
      + 'para el libre ejercicio del derecho a la terminación unilateral del contrato, por parte '
      + 'del abonado, suscriptor o cliente, manteniendo únicamente la obligación de pago por los '
      + 'servicios efectivamente prestados y condiciones contratadas hasta la terminación del '
      + 'contrato, los cuales podrán ser recaudados por el prestador a través de los mecanismos y '
      + 'procedimiento legales correspondientes.',
  },
  {
    n: 'CLÁUSULA DÉCIMA TERCERA',
    titulo: 'Controversias',
    texto:
      'Las diferencias que surjan de la ejecución del presente contrato, podrán ser resueltas por '
      + 'mutuo acuerdo entre las partes, sin perjuicio de que el Abonado acuda con su reclamo, '
      + 'queja o denuncia, ante las autoridades administrativas que correspondan. De no llegarse '
      + 'a una solución, cualquiera de las partes podrá acudir ante los jueces competentes. No '
      + 'obstante, lo indicado las partes pueden pactar adicionalmente, someter sus controversias '
      + 'ante un centro de mediación o arbitraje, si así lo deciden expresamente, en cuyo caso el '
      + 'Abonado deberá señalarlo en forma expresa.',
    numerales: [
      'El Abonado, en caso de conflicto, acepta someterse a la mediación o arbitraje (puede '
      + 'significar costos en los que debe incurrir el Abonado – No aplica a Empresas Públicas '
      + 'prestadoras de servicios de telecomunicaciones)',
    ],
    condicion: 'arbitraje',
    etiqueta_condicion: 'Firma de aceptación-sujeción a arbitraje:',
    raya_firma: true,
  },
  {
    n: 'CLAUSULA DECIMA CUARTA',
    titulo: 'Notificaciones y Domicilio',
    texto:
      'Las notificaciones que corresponda, serán entregadas en el domicilio de cada una de las '
      + 'partes señalado en la cláusula primera del presente contrato. Cualquier cambio de '
      + 'domicilio debe ser comunicado por escrito a la otra parte en un plazo de 10 días, a '
      + 'partir del día siguiente en que el cambio se efectúe.',
  },
  {
    n: 'CLAUSULA DECIMA QUINTA',
    titulo: 'Empaquetamiento de servicios',
    texto: 'La contratación incluye empaquetamiento de servicios:',
    condicion: 'empaquetamiento',
    bloque: 'paquetes',
  },
]

/** Las causales de terminación, que van en dos columnas de la cláusula doce. */
export const CAUSALES = {
  prestador: [
    'a) Incumplimiento de las condiciones contractuales del Abonado o la consignación de datos '
    + 'erróneos o falsos',
    'b) Si el Abonado utiliza los servicios contratados para fines distintos a los convenidos o '
    + 'si los utiliza en prácticas contrarias a la ley.',
    'c) Por vencimiento del plazo de vigencia del contrato, cuando no exista renovación.',
    'd) Por falta de pago.',
    'e) Por las demás causas previstas en el Ordenamiento Jurídico Vigente.',
  ],
  abonado: [
    'a) Por decisión unilateral del Abonado de dar por terminado el contrato.',
    'b) Por vencimiento del plazo de vigencia del contrato, cuando no exista renovación pactada.',
    'c) Por incumplimiento de las condiciones contractuales pactadas.',
    'd) Por las demás causas previstas en el Ordenamiento Jurídico Vigente.',
  ],
}

/** Los canales del regulador. No dependen del ISP: son los de la ARCOTEL. */
export const CANALES_ARCOTEL = [
  'Plataforma GOB.EC',
  'ARCOTEL',
  'a) Atención Presencial (Oficinas de la ARCOTEL).',
  'b) PBX-Directo Matriz, Coordinaciones Zonales y Oficinas Técnicas.',
  'c) Call Center (llamadas gratuitas al número 1800-567567 o número que designe la ARCOTEL).',
  'd) Correo Tradicional (oficios), o;',
  'e) Cualquier otro medio tecnológico o aplicativo que la ARCOTEL ponga a disposición.',
]

/** El cierre del contrato, antes de las firmas. */
export const CIERRE =
  'El Abonado acepta el presente contrato con sus términos y condiciones y demás documentos '
  + 'anexos para lo cual deja constancia de lo anterior y firman junto con {{empresa}} en tres '
  + 'ejemplares del mismo tenor, en la ciudad de {{ciudad_prestador}} a los {{fecha_larga}}'

/** Las redes de acceso del anexo 1f. */
export const REDES_ACCESO = ['Par de Cobre', 'Fibra óptica', 'Coaxial', 'Inalámbrico', 'Otros']

/** Los tipos de cuenta del anexo 1f. */
export const TIPOS_CUENTA = ['Residencial', 'Corporativo', 'Cibercafé', 'Otros tipos']

/** El texto del anexo 2, que es la autorización que firma el abonado. */
export const ANEXO_2 =
  'El SUSCRIPTOR autoriza expresamente al PRESTADOR a hacer uso de su información personal y de '
  + 'contacto para fines de índole comercial propios de la empresa prestadora y que consiste en '
  + 'la difusión de mensajes publicitarios y comerciales relativos a servicios de '
  + 'telecomunicaciones adicionales que el PRESTADOR ofrece a sus clientes. En cualquier momento, '
  + 'el abonado, suscriptor o cliente, podrá revocar su consentimiento, sin que el prestador '
  + 'pueda condicionar o establecer requisitos para tal fin, adicionales a la simple voluntad del '
  + 'abonado, suscriptor o cliente. Autorizo(amos) expresa e irrevocablemente a {{prestador}} '
  + 'para que obtenga cuantas veces sean necesarias, de cualquier fuente de información, '
  + 'incluidos los burós de crédito, mi información de riesgos crediticios, de igual forma '
  + '{{prestador}} queda expresamente autorizado para que pueda transferir o entregar dicha '
  + 'información a los burós de crédito y/o a la Central de Riesgos si fuere pertinente".'

/** Los términos del anexo 3, sobre los equipos. */
export const ANEXO_3_TERMINOS = [
  '1. Arrendamiento del Router: El equipo es propiedad de El prestador del servicio y no tiene '
  + 'valor alguno por su arrendamiento ya que es parte fundamental e indispensable en la '
  + 'prestación del servicio.',
  '2. Venta de Equipos Adicionales: Únicamente si el abonado solicita un equipo adicional como '
  + 'extensores de señal se cobrará un valor dependiendo del MODELO, este valor se detallará en '
  + 'la tabla de "Equipos Entregados" y en "FORMA DE PAGO" y deberá ser aprobado por el abonado '
  + 'mediante su firma de aceptación al final de este documento.',
  '3. Renovación del Router: En los casos de renovación del contrato, el prestador propenderá al '
  + 'cambio del equipo, cuando este haya alcanzado la obsolescencia tecnológica que impida '
  + 'garantizar la calidad y las condiciones en la prestación del servicio contratado, sin costo '
  + 'adicional para el caso de los equipos que sean parte fundamental e indispensable en la '
  + 'prestación del servicio.',
]

/** El pie que verifica que el papel corresponde a un modelo aprobado. */
export const PIE_INSCRIPCION =
  'La fecha de inscripción del modelo de contrato de adhesión que se utiliza es: {{inscripcion}}'

/** Reemplaza {{marcador}} por su valor. Lo que no se conoce queda como está. */
export function llenar(texto, datos = {}) {
  return String(texto ?? '').replace(/\{\{\s*(\w+)\s*\}\}/g, (original, clave) =>
    datos[clave] != null && datos[clave] !== '' ? String(datos[clave]) : original,
  )
}
