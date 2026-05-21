const express = require("express");
const axios = require("axios");
const pLimit = require("p-limit").default;

const app = express();

// ===============================
// CORS FIX
// ===============================

app.use((req, res, next) => {

  res.setHeader(
    "Access-Control-Allow-Origin",
    "*"
  );

 res.setHeader(
  "Access-Control-Allow-Headers",
  "Content-Type"
);

  res.setHeader(
    "Access-Control-Allow-Methods",
    "GET, POST, PUT, DELETE, OPTIONS"
  );

  if (req.method === "OPTIONS") {
    return res.status(200).end();
  }

  next();

});

app.use(express.json({
  limit: "50mb"
}));

const limit = pLimit(15);

// ===============================
// HOME
// ===============================

app.get("/", (req, res) => {
  res.send("Backend PRUEBA 5");
});

// ===============================
// APPLY CAMPAIGN
// ===============================

app.post("/apply-campaign", async (req, res) => {

  res.json({
    ok: true,
    message: "Campaña iniciada"
  });

  try {

    const {
      contacts = [],
      token,
      templateName,
      phoneNumberId,
    } = req.body;

    console.log(`Procesando ${contacts.length} contactos`);

    const jobs = contacts.map(contact =>
      limit(async () => {

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
                  code: "es_CO"
                }
              }
            },
            {
              headers: {
                Authorization: `Bearer ${token}`,
                "Content-Type": "application/json",
              }
            }
          );

          console.log("OK:", contact.phone);

        } catch (err) {

          console.error(
            "ERROR:",
            contact.phone,
            err?.response?.data || err.message
          );

        }

      })
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