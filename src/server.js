const express = require("express");
const axios = require("axios");
const cors = require("cors");
const pLimit = require("p-limit").default;

const app = express();

// ===============================
// CORS GLOBAL FIX
// ===============================

app.use(
  cors({
    origin: "*",
    methods: ["GET", "POST", "PUT", "DELETE", "OPTIONS"],
    allowedHeaders: [
      "Origin",
      "X-Requested-With",
      "Content-Type",
      "Accept",
      "Authorization",
    ],
  }),
);


app.use(
  express.json({
    limit: "50mb",
  }),
);
const limit = pLimit(3);
// ===============================
// HOME
// ===============================

app.get("/", (req, res) => {
  res.send("Backend funcionando");
});

// ===============================
// APPLY CAMPAIGN
// ===============================

app.post("/apply-campaign", async (req, res) => {
  // RESPUESTA INMEDIATA
  res.json({
    ok: true,
    message: "Campaña iniciada",
  });

  try {
    const { contacts = [], token, templateName, phoneNumberId } = req.body;

    console.log(`Procesando ${contacts.length} contactos`);

    const jobs = contacts.map((contact) =>
      limit(async () => {
        await new Promise(r => setTimeout(r, 1500));
        try {
          await axios.post(
            `https://graph.facebook.com/v22.0/${phoneNumberId}/messages`,
            {
              messaging_product: "whatsapp",
              to: contact.phone,
              type: "template",
              template: {
                name: templateName,
                language: {
                  code: "es_CO",
                },
                components: [
                  {
                    type: "body",
                    parameters: [
                      {
                        type: "text",
                        parameter_name: "nombre",
                        text: contact.name || "Cliente",
                      },
                      {
                        type: "text",
                        parameter_name: "destino",
                        text: contact.campaign || "Campana",
                      },
                    ],
                  },
                ],
              },
            },
            {
              headers: {
                Authorization: `Bearer ${token}`,
                "Content-Type": "application/json",
              },
            },
          );

          console.log("OK:", contact.phone);
        } catch (err) {
          console.error(
            "ERROR:",
            contact.phone,
            err?.response?.data || err.message,
          );
        }
      }),
    );

    await Promise.allSettled(jobs);

    console.log("Campaña finalizada");
  } catch (err) {
    console.error(err);
  }
});

const PORT = process.env.PORT || 3000;

app.listen(PORT, () => {
  console.log("Servidor iniciado en puerto", PORT);
});
