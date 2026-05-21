const express = require("express");
const cors = require("cors");
const axios = require("axios");
const pLimit = require("p-limit").default;

const app = express();

app.use(cors({
  origin: "*",
  methods: ["GET", "POST", "PUT", "DELETE", "OPTIONS"],
  allowedHeaders: ["Content-Type", "Authorization"],
}));

app.options(/.*/, cors());

app.use(express.json({
  limit: "50mb"
}));

const limit = pLimit(15);

app.get("/", (req, res) => {
  res.send("Backend funcionando 🚀");
});

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