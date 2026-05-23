const {
  normalizeWhatsappRecipient,
  normalizeWhatsappRecipientColombia,
  getTemplateBodyText,
  buildTemplateParameters,
} = require("../src/lib/whatsapp");

describe("normalizeWhatsappRecipient — Colombia (compatibilidad)", () => {
  test("acepta 12 dígitos empezando por 57", () => {
    expect(normalizeWhatsappRecipient("573001234567")).toBe("573001234567");
  });

  test("prefija 57 al móvil de 10 dígitos empezando por 3", () => {
    expect(normalizeWhatsappRecipient("3001234567")).toBe("573001234567");
  });

  test("acepta formato +57 con espacios y guiones", () => {
    expect(normalizeWhatsappRecipient("+57 300 123 4567")).toBe("573001234567");
    expect(normalizeWhatsappRecipient("+57-300-1234567")).toBe("573001234567");
  });

  test("alias legacy normalizeWhatsappRecipientColombia sigue funcionando", () => {
    expect(normalizeWhatsappRecipientColombia("3001234567")).toBe("573001234567");
    expect(normalizeWhatsappRecipientColombia("+57 300 123 4567")).toBe("573001234567");
  });
});

describe("normalizeWhatsappRecipient — internacional", () => {
  test("acepta US/Canada con +1 (separadores varios)", () => {
    expect(normalizeWhatsappRecipient("+1 (202) 555-1234")).toBe("12025551234");
    expect(normalizeWhatsappRecipient("+1-202-555-1234")).toBe("12025551234");
  });

  test("acepta US/Canada en E.164 sin + (11 dígitos empezando por 1)", () => {
    expect(normalizeWhatsappRecipient("12025551234")).toBe("12025551234");
  });

  test("acepta México con +52", () => {
    expect(normalizeWhatsappRecipient("+52 55 1234 5678")).toBe("525512345678");
    expect(normalizeWhatsappRecipient("525512345678")).toBe("525512345678");
  });

  test("acepta España con +34", () => {
    expect(normalizeWhatsappRecipient("+34 612 345 678")).toBe("34612345678");
  });

  test("acepta UK con +44", () => {
    expect(normalizeWhatsappRecipient("+44 7400 123456")).toBe("447400123456");
  });

  test("acepta Brasil con +55 incluyendo guión", () => {
    expect(normalizeWhatsappRecipient("+55 11 91234-5678")).toBe("5511912345678");
  });
});

describe("normalizeWhatsappRecipient — rechazos", () => {
  test("rechaza vacío, null, undefined", () => {
    expect(normalizeWhatsappRecipient("")).toBe("");
    expect(normalizeWhatsappRecipient(null)).toBe("");
    expect(normalizeWhatsappRecipient(undefined)).toBe("");
  });

  test("rechaza con + pero menos de 8 dígitos", () => {
    expect(normalizeWhatsappRecipient("+574567")).toBe("");
    expect(normalizeWhatsappRecipient("+1 234")).toBe("");
  });

  test("rechaza con + pero más de 15 dígitos", () => {
    expect(normalizeWhatsappRecipient("+1234567890123456")).toBe("");
  });

  test("rechaza 10 dígitos sin + que no empiezan por 3 (ambiguo)", () => {
    // Podría ser US local (sin código país) o cualquier otro: no asumimos nada.
    expect(normalizeWhatsappRecipient("1234567890")).toBe("");
    expect(normalizeWhatsappRecipient("2125551234")).toBe("");
    expect(normalizeWhatsappRecipient("4001234567")).toBe("");
  });

  test("rechaza menos de 10 dígitos sin +", () => {
    expect(normalizeWhatsappRecipient("300123")).toBe("");
    expect(normalizeWhatsappRecipient("3001234")).toBe("");
  });

  test("rechaza letras o basura sin + ni dígitos", () => {
    expect(normalizeWhatsappRecipient("abc")).toBe("");
  });

  test("limpia separadores pero respeta la longitud mínima", () => {
    // "300abc1234" → digitsOnly "3001234" (7 dígitos, no 10) → rechazado.
    expect(normalizeWhatsappRecipient("300abc1234")).toBe("");
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
