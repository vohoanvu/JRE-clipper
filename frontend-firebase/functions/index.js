const { onRequest } = require("firebase-functions/v2/https");
const cors = require("cors")({ origin: true });
const { GoogleAuth } = require("google-auth-library");

// This function will be used to get a token for the Vertex AI Search widget
exports.getVertexAiToken = onRequest((req, res) => {
  cors(req, res, async () => {
    try {
      const auth = new GoogleAuth({
        scopes: "https://www.googleapis.com/auth/cloud-platform",
      });
      const client = await auth.getClient();
      const accessToken = await client.getAccessToken();
      res.status(200).send({ accessToken: accessToken.token });
    } catch (error) {
      console.error("Error getting access token:", error);
      res.status(500).send({ error: "Could not generate access token." });
    }
  });
});
