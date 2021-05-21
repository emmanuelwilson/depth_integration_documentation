import express from "express";
import Ajv from "ajv/dist/2020";

import querySchemaJSON from "./schemas/request.schema.json";
import handlerResponseSchemaJSON from "./schemas/handler-response.schema.json";
import definitionsJSON from "./schemas/definitions.json";

const app = express();
const port = 80;
const ajv = new Ajv({
    "schemas": [querySchemaJSON, definitionsJSON, handlerResponseSchemaJSON]
});

function generateRendering(): object {
    return {
        "type_id": "ca.mcgill.cim.bach.atp.renderer.HelloWorld",
        "confidence": 100,
        "description": "An example rendering that conveys no useful information.",
        "metadata": {
            "description": "This was generated by the \"hello handler\" container, an example of how to structure a handler. It is not meant to be used in production."
        },
        "data": {
            "text": "Hello, World!"
        }
    };
}

app.use(express.json());

app.post("/atp/handler", (req, res) => {
    if (ajv.validate("https://bach.cim.mcgill.ca/atp/request.schema.json", req.body)) {
        // tslint:disable-next-line:no-console
        console.log("Request validated");
        const rendering = generateRendering();
        const response = {
            "request_uuid": req.body.request_uuid,
            "timestamp": Math.round(Date.now() / 1000),
            "renderings": [
                rendering
            ]
        };
        if (ajv.validate("https://bach.cim.mcgill.ca/atp/handler-response.schema.json", response)) {
            // tslint:disable-next-line:no-console
            console.log("Valid response generated.");
            res.json(response);
        } else {
            // tslint:disable-next-line:no-console
            console.log("Failed to generate a valid response (did the schema change?)");
            res.status(500).json(ajv.errors);
        }
    } else {
        // tslint:disable-next-line:no-console
        console.log("Request did not pass the schema.");
        res.status(400).send(ajv.errors);
    }
});

app.listen(port, () => {
    // tslint:disable-next-line:no-console
    console.log(`Started server on port ${port}`);
});
