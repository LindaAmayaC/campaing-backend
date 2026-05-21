const express = require("express");
const cors = require("cors");

const app = express();

app.use(cors());

app.use(express.json({
  limit: "50mb"
}));

app.get("/", (req, res) => {
  res.send("Backend funcionando 🚀");
});

app.post("/apply-campaign", async (req, res) => {

  console.log("Campaña recibida");

  console.log(req.body);

  res.json({
    ok: true,
    message: "Campaña iniciada"
  });

});

const PORT = process.env.PORT || 3000;


app.listen(PORT, () => {
  console.log("Servidor iniciado en puerto", PORT);
});