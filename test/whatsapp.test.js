const {
  normalizeWhatsappRecipientColombia,
  getTemplateBodyText,
  buildTemplateParameters,
} = require("../src/lib/whatsapp");

describe("normalizeWhatsappRecipientColombia", () => {
  test("acepta 12 dígitos empezando por 57", () => {
    expect(normalizeWhatsappRecipientColombia("573001234567")).toBe("573001234567");
  });

  test("prefija 57 al móvil de 10 dígitos empezando por 3", () => {
    expect(normalizeWhatsappRecipientColombia("3001234567")).toBe("573001234567");
  });

  test("acepta formato +57 con espacios y guiones", () => {
    expect(normalizeWhatsappRecipientColombia("+57 300 123 4567")).toBe("573001234567");
    expect(normalizeWhatsappRecipientColombia("+57-300-1234567")).toBe("573001234567");
  });

  test("rechaza vacío, null, undefined", () => {
    expect(normalizeWhatsappRecipientColombia("")).toBe("");
    expect(normalizeWhatsappRecipientColombia(null)).toBe("");
    expect(normalizeWhatsappRecipientColombia(undefined)).toBe("");
  });

  test("rechaza menos de 10 dígitos", () => {
    expect(normalizeWhatsappRecipientColombia("300123")).toBe("");
    expect(normalizeWhatsappRecipientColombia("3001234")).toBe("");
  });

  test("rechaza 10 dígitos que no empiezan por 3", () => {
    expect(normalizeWhatsappRecipientColombia("1234567890")).toBe("");
    expect(normalizeWhatsappRecipientColombia("4001234567")).toBe("");
  });

  test("rechaza otros prefijos de país", () => {
    expect(normalizeWhatsappRecipientColombia("5912345678901")).toBe("");
    expect(normalizeWhatsappRecipientColombia("13001234567")).toBe("");
  });

  test("rechaza letras o basura", () => {
    expect(normalizeWhatsappRecipientColombia("abc")).toBe("");
    expect(normalizeWhatsappRecipientColombia("300abc1234")).toBe("");
  });
});

describe("getTemplateBodyText", () => {
  test("devuelve string vacío si no hay template", () => {
    expect(getTemplateBodyText(null)).toBe("");
    expect(getTemplateBodyText(undefined)).toBe("");
    expect(getTemplateBodyText({})).toBe("");
  });

  test("extrae texto del componente BODY", () => {
    const tpl = {
      components: [
        { type: "HEADER", text: "Hola" },
        { type: "BODY", text: "Hola {{nombre}} en {{destino}}" },
        { type: "FOOTER", text: "Footer" },
      ],
    };
    expect(getTemplateBodyText(tpl)).toBe("Hola {{nombre}} en {{destino}}");
  });

  test("toUpperCase: acepta 'body' minúsculas", () => {
    const tpl = { components: [{ type: "body", text: "abc" }] };
    expect(getTemplateBodyText(tpl)).toBe("abc");
  });

  test("devuelve string vacío si BODY no existe", () => {
    const tpl = { components: [{ type: "HEADER", text: "x" }] };
    expect(getTemplateBodyText(tpl)).toBe("");
  });
});

describe("buildTemplateParameters", () => {
  test("template sin variables → params vacíos", () => {
    expect(buildTemplateParameters("Hola, gracias", "Linda", "Camp")).toEqual([]);
  });

  test("template con {{nombre}}", () => {
    const params = buildTemplateParameters("Hola {{nombre}}", "Linda", "Camp");
    expect(params).toEqual([
      { type: "text", parameter_name: "nombre", text: "Linda" },
    ]);
  });

  test("template con {{nombre}} y {{destino}}", () => {
    const params = buildTemplateParameters(
      "Hola {{nombre}} en {{destino}}",
      "Linda",
      "Cancún",
    );
    expect(params).toEqual([
      { type: "text", parameter_name: "nombre", text: "Linda" },
      { type: "text", parameter_name: "destino", text: "Cancún" },
    ]);
  });

  test("acepta placeholders posicionales {{1}} y {{2}}", () => {
    const params = buildTemplateParameters("Hola {{1}} en {{2}}", "Ana", "Madrid");
    expect(params).toEqual([
      { type: "text", parameter_name: "nombre", text: "Ana" },
      { type: "text", parameter_name: "destino", text: "Madrid" },
    ]);
  });

  test("defaults Cliente/Campana cuando faltan valores", () => {
    const params = buildTemplateParameters("Hola {{nombre}} {{destino}}", "", "");
    expect(params[0].text).toBe("Cliente");
    expect(params[1].text).toBe("Campana");
  });

  test("ignora placeholders desconocidos (no mapea {{ciudad}})", () => {
    const params = buildTemplateParameters("Hola {{ciudad}}", "Linda", "C");
    expect(params).toEqual([]);
  });

  test("case-insensitive: {{NOMBRE}} también funciona", () => {
    const params = buildTemplateParameters("Hola {{NOMBRE}}", "Linda", "C");
    expect(params).toEqual([
      { type: "text", parameter_name: "nombre", text: "Linda" },
    ]);
  });
});
