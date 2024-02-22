/**
 * GitHub  https://github.com/tanaikech/ImageBotApp<br>
 * 
 * Application name. This name is used in the notification email.
 * @type {string}
 * @const {string}
 * @readonly
 */
var appName = "ImageBotApp";

// Please use this when you want to directly copy and paste these scripts ahd HTML instead of the library.
const ImageBotApp = { main };

/**
* ### Description
* Main of image bot.
*
* @param {Object} obj Object for running image bot.
* @returns {(HtmlService.HtmlOutput|Object))} HtmlService.HtmlOutput or object.
*/
function main(obj) {
  try {
    if (obj.run) {
      return functionList_[obj.run](obj);
    }
    return HtmlService.createHtmlOutputFromFile("index");
  } catch ({ stack }) {
    throw new Error(stack);
  }
}

/**
 * ### Description
 * Function listLibrary name
 * 
 * @type {Object}
 * @const {Object}
 * @readonly
 */
const functionList_ = {
  doGemini: doGemini_,
  saveFiles: saveFiles_,
}

/**
* ### Description
* Save uploaded image data.
*
* @param {Object} object Object for saving image data.
* @returns {Object} Array
*/
function saveFiles_(object) {
  const { obj, folderId, newDocumentName } = object;
  if (obj.length == 0) {
    return { ret: "No files" };
  }
  const folder = DriveApp.getFolderById(folderId);
  const headers = { authorization: "Bearer " + ScriptApp.getOAuthToken() };
  const { requests, ret } = obj.reduce((o, e) => {
    const file = folder.createFile(Utilities.newBlob(...e));
    const fileId = file.getId();
    const base64 = Utilities.base64Encode(UrlFetchApp.fetch(`https://drive.google.com/thumbnail?sz=w1000&id=${fileId}`, { headers }).getContent());
    const url = "https://generativelanguage.googleapis.com/v1beta/models/gemini-pro-vision:generateContent";
    const payload = { contents: [{ parts: [{ text: "Explain about this picture within 50 words." }, { inline_data: { mime_type: "image/png", data: base64 } }] }] };
    const options = { payload: JSON.stringify(payload), contentType: "application/json", headers };
    const res = UrlFetchApp.fetch(url, options);
    const obj = JSON.parse(res.getContentText());
    if (obj.candidates && obj.candidates[0].content && obj.candidates[0].content.parts) {
      const description = obj.candidates[0].content.parts[0].text;
      o.ret.push({ fileUrl: file.getUrl(), dataUrl: `data:image/png;base64,${base64}`, description });
      o.requests.push({
        parent: newDocumentName.name,
        chunk: {
          data: { stringValue: description.trim() },
          customMetadata: [{ key: "fileId", stringValue: fileId }, { key: "url", stringValue: file.getUrl() }]
        }
      });
    }
    return o;
  }, { requests: [], ret: [] });
  if (requests.length > 0) {
    CorporaApp.setChunks(newDocumentName.name, { requests });
  }
  const pseudoModel = { parts: [{ text: "URLs and descriptions of the uploaded image files are as follows.\n" + ret.map(({ fileUrl, description }) => `URL is ${fileUrl}. Description of ${fileUrl} is ${description}.`).join(",") }], role: "model" };
  return { ret, pseudoModel };
}

/**
* ### Description
* Object including the functions of function calling.
*
* @param {Object} object Object for using function calling.
* @returns {Object} Object
*/
function functions_({ newDocumentName }) {
  return {
    params_: {
      searchImages: {
        description: "Search images and descriptions of images from the image stock. Get images and descriptions of images from the image stock by searching.",
        parameters: {
          type: "object",
          properties: {
            searchText: {
              type: "string",
              description: "Search text for searching images and descriptions of the images from the image stock. Texts. Words."
            },
            numberOfImages: {
              type: "number",
              description: "Number of output images. Default number is 2."
            },
          },
          required: ["searchText", "numberOfImages"]
        }
      },
      uploadImages: {
        description: "Upload images. Upload image files. Make users upload image files. Upload a single image file and multiple image files. Add image and file.",
      },
    },
    searchImages: function ({ searchText, numberOfImages = 2 }) {
      const res = CorporaApp.searchQueryFromDocument(newDocumentName.name, { query: searchText, resultsCount: numberOfImages });
      const obj = JSON.parse(res.getContentText());
      const data = obj.relevantChunks.map(({ chunk }) => ({
        chunk, ...chunk.customMetadata.reduce((o, { key, stringValue }) => (o[key] = stringValue, o), {})
      }));
      const text = "Searched images are as follows. " + data.map(({ url, chunk: { data: { stringValue } } }) => `URL and description of searched image are ${url} and ${stringValue}.`).join("\n");
      const pseudoModel = { parts: [{ text }], role: "model" };
      return { stopAtFunction: true, data, pseudoModel };
    },
    uploadImages: function () {
      return { uploadImage: HtmlService.createHtmlOutputFromFile("uploadImages").getContent() };
    }
  };
}

/**
* ### Description
* Request Gemini.
*
* @param {Object} object Object for requesting Gemini.
* @returns {Object} Object
*/
function doGemini_(object) {
  const { text, history } = object;
  const functions = functions_(object);
  const function_declarations = Object.keys(functions).flatMap(k => (k != "params_" ? { name: k, description: functions.params_[k].description, parameters: functions.params_[k].parameters } : []));
  const url = `https://generativelanguage.googleapis.com/v1beta/models/gemini-pro:generateContent`;
  const contents = [{ parts: [{ text }], role: "user" }];
  let check = true;
  let useFunction = false;
  const token = ScriptApp.getOAuthToken();
  const results = [];
  do {
    const payload = { contents, tools: [{ function_declarations }] };
    const options = { payload: JSON.stringify(payload), contentType: "application/json", headers: { authorization: "Bearer " + token }, muteHttpExceptions: true };
    const res = UrlFetchApp.fetch(url, options);
    if (res.getResponseCode() != 200) {
      throw new Error(res.getContentText());
    }
    const { candidates } = JSON.parse(res.getContentText());
    if (!candidates[0].content?.parts) {
      results.push(candidates[0]);
      break
    }
    const parts = candidates[0].content?.parts;
    contents.push({ parts: parts.slice(), role: "model" });
    check = parts.find(o => o.hasOwnProperty("functionCall"));
    if (check) {
      const functionName = check.functionCall.name;
      const res2 = functions[functionName](check.functionCall.args || null);
      contents.push({ parts: [{ functionResponse: { name: functionName, response: { name: functionName, content: res2 } } }], role: "function" });
      parts.push({ functionResponse: res2 });
      useFunction = true;
      if (res2.stopAtFunction) {
        check = false;
        if (res2.pseudoModel) {
          contents.push(res2.pseudoModel);
        }
      }
    }
    results.push(...parts);
  } while (check);
  const newHistory = [...history, ...contents];
  const lastResponse = useFunction ? results.reverse().find(r => r.functionResponse) : results.pop();
  if (lastResponse.functionResponse) {
    if (lastResponse.functionResponse.uploadImage) {
      return { response: "uploadImage", value: lastResponse.functionResponse.uploadImage, history: newHistory };
    } else if (lastResponse.functionResponse.data) {
      const urls = lastResponse.functionResponse.data.map(({ url }) => url);
      const dataUrls = lastResponse.functionResponse.data.map(({ fileId }) => {
        const file = DriveApp.getFileById(fileId);
        const base64 = Utilities.base64Encode(file.getBlob().getBytes());
        return `data:${file.getMimeType()};base64,${base64}`;
      });
      return { response: "url", value: urls, dataUrls, history: newHistory };
    }
  } else if (lastResponse.text) {
    return { response: "text", value: lastResponse.text, history: newHistory };
  }
  return { response: "text", value: "No response.", history: newHistory };
}
