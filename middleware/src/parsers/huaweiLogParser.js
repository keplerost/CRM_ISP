/**
 * `display log cli all` de un MA5800: una entrada por comando, de la más nueva
 * a la más vieja.
 *
 *   ------------------------------------------------------------------------------
 *   No.      UserName                         Domain               IP-Address
 *   74087    smartoltusr                      --                   172.16.10.3
 *   Time:    2026-09-11 01:39:57-05:00
 *   Cmd:     config
 *
 * Un comando largo sigue en la línea de abajo del `Cmd:`.
 */
export function parseRegistroCli(salida) {
  const texto = String(salida ?? '')
    .replace(/\x1b\[\d*[A-Za-z]/g, '')
    .replace(/\r/g, '')

  const entradas = []
  for (const bloque of texto.split(/^\s*-{20,}\s*$/m)) {
    const cabecera = bloque.match(/^\s*(\d+)\s+(\S+)\s+(\S+)\s+(\S+)\s*$/m)
    const fecha = bloque.match(/^\s*Time:\s*(.+?)\s*$/m)
    // Los comandos que el equipo rechazó vienen como "Failure Cmd:".
    const cmd = bloque.match(/^\s*(Failure\s+)?Cmd:\s*([\s\S]*)$/m)
    if (!cabecera || !fecha || !cmd) continue

    const comando = cmd[2]
      .split('\n')
      .map((l) => l.trim())
      // El prompt del equipo cierra la salida y queda pegado al último bloque.
      .filter((l) => l && !/^[\w-]+(\([^)]*\))?[#>%]+$/.test(l))
      .join(' ')

    entradas.push({
      numero: Number(cabecera[1]),
      usuario: cabecera[2],
      dominio: cabecera[3] === '--' ? null : cabecera[3],
      ip: cabecera[4] === '--' ? null : cabecera[4],
      fecha: fecha[1],
      comando,
      fallo: Boolean(cmd[1]),
    })
  }
  return entradas
}
