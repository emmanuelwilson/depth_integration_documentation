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
import { v4 as uuidv4 } from "uuid";
import fs from "fs/promises";

import querySchemaJSON from "./schemas/request.schema.json";
import handlerResponseJSON from "./schemas/handler-response.schema.json";
import definitionsJSON from "./schemas/definitions.json";
import ttsRequestJSON from "./schemas/services/tts/segment.request.json";
import ttsResponseJSON from "./schemas/services/tts/segment.response.json";
import descriptionJSON from "./schemas/services/supercollider/tts-description.schema.json";
import segmentJSON from "./schemas/services/supercollider/tts-segment.schema.json";
import rendererDefJSON from "./schemas/renderers/definitions.json";
import textJSON from "./schemas/renderers/text.schema.json"
import photoAudioHapticsJSON from "./photoaudiohaptics.schema.json";

import * as utils from "./utils";

const ajv = new Ajv({
    "schemas": [ querySchemaJSON, 
        handlerResponseJSON, 
        definitionsJSON, 
        ttsRequestJSON, 
        ttsResponseJSON, 
        descriptionJSON, 
        segmentJSON, 
        rendererDefJSON, 
        photoAudioHapticsJSON ]
});

const app = express();
const port = 80;
const scPort = 57120;
const filePrefix = "/tmp/sc-store/photo-audio-haptics-handler-";

app.use(express.json({limit: process.env.MAX_BODY}));

app.post("/handler", async (req, res) => {
    // Validate the request data (just in case)
    if (!ajv.validate("https://image.a11y.mcgill.ca/request.schema.json", req.body)) {
        console.warn("Request did not pass the schema!");
        res.status(400).json(ajv.errors);
        return;
    }

    const renderings:any = [];

    // *******************************************************
    // Check for preprocessor data
    // *******************************************************
    const preprocessors = req.body["preprocessors"];
    const preSecondCat = preprocessors["ca.mcgill.a11y.image.preprocessor.secondCategoriser"];
    const preSemSeg = preprocessors["ca.mcgill.a11y.image.preprocessor.semanticSegmentation"]
    const preObjDet = preprocessors["ca.mcgill.a11y.image.preprocessor.objectDetection"]
    const preGroupData = preprocessors["ca.mcgill.a11y.image.preprocessor.grouping"];

    if (!preObjDet && !preSemSeg && !preGroupData) {
        console.debug("No preprocessor data available: can't render!");
        const response = utils.generateEmptyResponse(req.body["request_uuid"]);

        if (ajv.validate("https://image.a11y.mcgill.ca/handler-response.schema.json", response)) {
            res.json(response);
        } else {
            console.error("Failed to generate a valid empty response!");
            console.error(ajv.errors);
            res.status(500).json(ajv.errors);
        }
        return;
    }

    // *******************************************************
    // Check for renderer availability
    // *******************************************************
    const hasText = req.body["renderers"].includes("ca.mcgill.a11y.image.renderer.Text");
    const hasAudioHaptic = req.body["renderers"].includes("ca.mcgill.a11y.image.renderer.PhotoAudioHaptics");
    if (!hasAudioHaptic && !hasText) {
        console.warn("Segment audio-haptic renderers not supported!");
        const response = utils.generateEmptyResponse(req.body["request_uuid"]);
        if (ajv.validate("https://image.a11y.mcgill.ca/handler-response.schema.json", response)) {
            res.json(response);
        } else {
            console.error("Failed to generate a valid empty response!");
            console.error(ajv.errors);
            res.status(500).json(ajv.errors);
        }
        return;
    }

    //const hapticObjInfo: { centroid: number[]; coordinates: number[]; }[] = [];
    const hapticSegInfo: { centroid: number[]; contourPoints: number[]; }[] = [];

    // *******************************************************
    // Audio TTS
    // *******************************************************
    // Begin forming text...
    // This is variable depending on which preprocessor data is available.
    const ttsData: utils.TTSSegment[] = [];
    ttsData.push({"value": utils.generateIntro(preSecondCat), "type": "text"});
    if (preSemSeg) {
        // Use all segments returned for now.
        // Filtering may be helpful later.
        ttsData.push(...utils.generateSemSeg(preSemSeg));
        if (preObjDet && preGroupData) {
            ttsData.push({"value": "It also", "type": "text"});
        }
    }
    if (preObjDet && preGroupData) {
        ttsData.push(...utils.generateObjDet(preObjDet, preGroupData));
    }

        // Concatenate adjacent text entries
        for (let i = 0; i < ttsData.length - 1; i++) {
            if (ttsData[i].type === "text" && ttsData[i+1].type === "text") {
                ttsData[i].value += " " + ttsData[i+1].value;
                ttsData.splice(i+1, 1);
            }
        }

    // Generate rendering title
    const renderingTitle = utils.renderingTitle(preSemSeg, preObjDet, preGroupData);

    // Construct text (if requested)
    if (hasText) {
        const textString = ttsData.map(x => x["value"]).join(" ");
        const rendering = {
            "type_id": "ca.mcgill.a11y.image.renderer.Text",
            "confidence": 50,
            "description": renderingTitle + " (text only)",
            "data": { "text": textString }
        };
        if (ajv.validate(textJSON, rendering["data"])) { //"https://image.a11y.mcgill.ca/renderers/text.schema.json"
            renderings.push(rendering);
            console.log("pushed text rendering!");
        } else {
            console.error("Failed to generate a valid text rendering!");
            console.error(ajv.errors);
            console.warn("Trying to continue...");
        }
    } else {
        console.debug("Skipped text rendering.");
    }

    // *******************************************************
    // Haptic seg and obj coordinate data
    // *******************************************************
    const groupCentroidArray: Array<Array<number>> = [];
    const groupCoordArray: Array<Array<number>> = [];

    const segments = preSemSeg["segments"];
    if (segments.length !== 0) {
        for (const segment of segments) {
            // Grab coordinates for haptic
            const contourPoints: number[] = segment["coord"];
            const center: number[] = segment["centroid"];
            const data = {
                "centroid": center,
                "contourPoints": contourPoints 
            }
            hapticSegInfo.push(data);
        }
    } else {
        console.warn("No segments were detected.");
    }

    const objects = preObjDet["objects"]
    if (objects.length !== 0) {

        for (const group of preGroupData["grouped"]) {
            const objsByGroup = preObjDet["objects"].filter((x: { "ID": number }) => group["IDs"].includes(x["ID"]));

            const centroidArray = [];
            const coordArray = [];
             for (let i = 0; i < objsByGroup.length; i++) {
               const centroid = objsByGroup[i]["centroid"]
               const coords = objsByGroup[i]["dimensions"]
               centroidArray.push(centroid)
               coordArray.push(coords)
             }
             groupCentroidArray.push(centroidArray);
             groupCoordArray.push(coordArray);
            }
        for (const idx of preGroupData["ungrouped"]) {
            const obj = preObjDet["objects"].find((x: { "ID": number }) => x["ID"] === idx);
            const centroid = obj["centroid"]
            const coords = obj["dimensions"]         
            groupCentroidArray.push(centroid);
            groupCoordArray.push(coords);
        }
    } else {
        console.warn("No objects were detected.");
    }

    //TODO: require image?
    const image = req.body.image;

    if (hasAudioHaptic) {
        try {
            // Do TTS
            const ttsResponse = await utils.getTTS(ttsData.map(x => x["value"]));
            // Add offset values to data
            for (let i = 0, offset = 0; i < ttsData.length; i++) {
                ttsData[i]["audio"] = {
                    "offset": offset,
                    "duration": ttsResponse.durations[i]
                };
                offset += ttsResponse.durations[i];
            }

            const scData = {
                "data": ttsData,
                "ttsFileName": ""
            };

            // Write to file
            let inFile: string, outFile: string, jsonFile: string;
            await fetch(ttsResponse["audio"]).then(resp => {
                return resp.arrayBuffer();
            }).then(async (buf) => {
                inFile = filePrefix + req.body["request_uuid"] + ".wav";
                await fs.writeFile(inFile, Buffer.from(buf));
                scData["ttsFileName"] = inFile;
                jsonFile = filePrefix + req.body["request_uuid"] + ".json";
                await fs.writeFile(jsonFile, JSON.stringify(scData));
                outFile = filePrefix + uuidv4() + ".flac";
                await fs.writeFile(outFile, "");
                await fs.chmod(outFile, 0o664);

                console.log("Forming OSC...");
                return utils.sendOSC(jsonFile, outFile, "supercollider", scPort);
            }).then(async (segArray:any) => {
                const buffer = await fs.readFile(outFile);
                // TODO detect mime type from file
                const dataURL = "data:audio/flac;base64," + buffer.toString("base64");
                if (hasAudioHaptic && segArray.length > 0 
                    && segArray.length > hapticSegInfo.length) {
                        
                    const s = [...segArray];

                    s[0] = { ...s[0], 
                            centroid: [[]],
                            contourPoints: [[]]};

                    s[1 + hapticSegInfo.length] = { ...s[1 + hapticSegInfo.length], 
                                centroid: [[]],
                                contourPoints: [[]]};                            

                    for (let i = 1; i <= hapticSegInfo.length; i++) {
                        s[i] = {...s[i], 
                            centroid: [hapticSegInfo?.[i - 1]?.['centroid']],
                            contourPoints: [hapticSegInfo?.[i - 1]?.['contourPoints']],
                        };    
                    }
                    const j = 1 + hapticSegInfo.length + 1;
                    for (let i = 0; i < objects.length; i++) {
                        s[i + j] = {...s[i + j], centroid: groupCentroidArray[i],
                        contourPoints: groupCoordArray[i],
                        };
                    }

                    const rendering = {
                        "type_id": "ca.mcgill.a11y.image.renderer.PhotoAudioHaptics",
                        "confidence": 50,
                        "description": renderingTitle,
                        "data": {
                            "image": image,
                            "info": {
                                "audioFile": dataURL,
                                "entityInfo": s,
                            },
                        }
                    };
                    if (ajv.validate("https://image.a11y.mcgill.ca/renderers/photoaudiohaptics.schema.json", rendering["data"])) {
                        console.log("validated audio haptics!");
                        renderings.push(rendering);
                        // console.log(renderings);
                    } else {
                        console.error(ajv.errors);
                    }
                }
            }).finally(() => {
                // Delete our files if they exist on the disk
                console.log("doing final step!");
                if (inFile !== undefined) {
                    fs.access(inFile).then(() => { return fs.unlink(inFile); }).catch(() => { /* noop */ });
                }
                if (jsonFile !== undefined) {
                    fs.access(jsonFile).then(() => { return fs.unlink(jsonFile); }).catch(() => { /* noop */ });
                }
                if (outFile !== undefined) {
                    fs.access(outFile).then(() => { return fs.unlink(outFile); }).catch(() => { /* noop */ });
                }
            });
        } catch(e) {
            console.error("Failed to generate audio!");
            console.error(e);
        }
    }

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

// Run the server
app.listen(port, () => {
    console.log(`Started server on port ${port}`);
});