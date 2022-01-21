/*
 * Copyright (c) 2021 IMAGE Project, Shared Reality Lab, McGill University
 *
 * This program is free software: you can redistribute it and/or modify
 * it under the terms of the GNU Affero General Public License as
 * published by the Free Software Foundation, either version 3 of the
 * License, or (at your option) any later version.
 *
 * This program is distributed in the hope that it will be useful,
 * but WITHOUT ANY WARRANTY; without even the implied warranty of
 * MERCHANTABILITY or FITNESS FOR A PARTICULAR PURPOSE.  See the
 * GNU Affero General Public License for more details.
 * You should have received a copy of the GNU Affero General Public License
 * and our Additional Terms along with this program.
 * If not, see <https://github.com/Shared-Reality-Lab/IMAGE-server/LICENSE>.
 */
import Ajv from "ajv";
import express from "express";
import fetch from "node-fetch";

import * as utils from "./utils";

import querySchemaJSON from "./schemas/request.schema.json";
import handlerResponseJSON from "./schemas/handler-response.schema.json";
import definitionsJSON from "./schemas/definitions.json";
import ttsRequestJSON from "./schemas/services/tts/segment.request.json";
import ttsResponseJSON from "./schemas/services/tts/segment.response.json";
import descriptionJSON from "./schemas/services/supercollider/tts-description.schema.json";
import segmentJSON from "./schemas/services/supercollider/tts-segment.schema.json";
import rendererDefJSON from "./schemas/renderers/definitions.json";
import simpleAudioJSON from "./schemas/renderers/simpleaudio.schema.json";
import segmentAudioJSON from "./schemas/renderers/segmentaudio.schema.json";
import textJSON from "./schemas/renderers/text.schema.json";

const ajv = new Ajv({
    "schemas": [ querySchemaJSON, handlerResponseJSON, definitionsJSON, ttsRequestJSON, ttsResponseJSON, descriptionJSON, segmentJSON, rendererDefJSON, simpleAudioJSON, segmentAudioJSON, textJSON ]
});

const app = express();
const port = 80;

app.use(express.json({limit: process.env.MAX_BODY}));

app.post("/handler", async (req, res) => {
    // Validate the request data
    if (!ajv.validate("https://image.a11y.mcgill.ca/request.schema.json", req.body)) {
        console.warn("Request did not pass the schema!");
        res.status(400).json(ajv.errors);
    }

    const renderings = [];

    // Get preprocessors
    const preprocessors = req.body["preprocessors"];
    const secondCat = preprocessors["ca.mcgill.a11y.image.preprocessor.secondCategoriser"];
    const semseg = preprocessors["ca.mcgill.a11y.image.preprocessor.semanticSegmentation"];
    const objDet = preprocessors["ca.mcgill.a11y.image.preprocessor.objectDetection"];
    const objGroup = preprocessors["ca.mcgill.a11y.image.preprocessor.grouping"];

    // Ignore secondCat since it isn't useful on its own
    if (!semseg && !objDet && !objGroup) {
        console.debug("No usable preprocessor data! Can't render.");
        const response = utils.generateEmptyResponse(req.body["request_uuid"]);
        res.json(response);
        return;
    }

    // Check renderers
    const hasText = req.body["renderers"].includes("ca.mcgill.a11y.image.renderer.Text");
    const hasSimple = req.body["renderers"].includes("ca.mcgill.a11y.image.renderer.SimpleAudio");
    const hasSegment = req.body["renderers"].includes("ca.mcgill.a11y.image.renderer.SegmentAudio");
    if (!hasText && !hasSimple && !hasSegment) {
        console.warn("No compatible renderers supported! (Text, SimpleAudio, SegmentAudio)");
        const response = utils.generateEmptyResponse(req.body["request_uuid"]);
        res.json(response);
        return;
    }

    // Begin forming text...
    // This is variable depending on which preprocessor data is available.
    const ttsData: utils.TTSSegment[] = [];
    ttsData.push({"value": utils.generateIntro(secondCat), "type": "text"});
    if (semseg) {
        // Use all segments returned for now.
        // Filtering may be helpful later.
        ttsData.push(...utils.generateSemSeg(semseg));
        ttsData.push({"value": "It also", "type": "text"});
    }
    if (objDet && objGroup) {
        ttsData.push(...utils.generateObjDet(objDet, objGroup));
    }

    // Construct Text (if requested)
    if (hasText) {
        const textString = ttsData.map(x => x["value"]).join(" ");
        const rendering = {
            "type_id": "ca.mcgill.a11y.image.renderer.Text",
            "confidence": 50,
            "description": "Regions, things, and people (text only)",
            "data": { "text": textString }
        };
        if (ajv.validate("https://image.a11y.mcgill.ca/renderers/text.schema.json", rendering["data"])) {
            renderings.push(rendering);
        } else {
            console.error("Failed to generate a valid text rendering!");
            console.error(ajv.errors);
            console.warn("Trying to continue...");
        }
    } else {
        console.debug("Skipped text rendering.");
    }

    // TODO audio

    // Send response

    const response = utils.generateEmptyResponse(req.body["request_uuid"]);
    response["renderings"] = renderings;
    if (ajv.validate("https://image.a11y.mcgill.ca/handler-response.schema.json", response)) {
        res.json(response);
    } else {
        console.error("Failed to generate a valid response.");
        console.error(ajv.errors);
        res.status(500).json(ajv.errors);
    }
});

app.listen(port, () => {
    console.log("Started server on port " + port);
});
