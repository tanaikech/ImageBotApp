/**
* ### Description
* Put image descriptions to corpus.
*
* @param {Object} obj Object including "folderId", "newCorpusName", "newDocumentName".
* @returns {UrlFetchApp.HTTPResponse[]} HTTPResponse[]
*/
function putImageDescriptionsToCorpus(obj) {
  if (!obj || !["folderId", "newCorpusName", "newDocumentName"].some(k => k in obj)) {
    throw new Error("Please set a valid object.");
  }
  const { folderId, newCorpusName, newDocumentName } = obj;

  /**
   * ### Description
   * Generate text from text and image.
   * ref: https://medium.com/google-cloud/automatically-creating-descriptions-of-files-on-google-drive-using-gemini-pro-api-with-google-apps-7ef597a5b9fb
   *
   * @param {Object} object Object including API key, text, mimeType, and image data.
   * @return {String} Generated text.
   */
  function getResFromImage_(object) {
    const { token, text, mime_type, data } = object;
    const url = `https://generativelanguage.googleapis.com/v1/models/gemini-pro-vision:generateContent`;
    const payload = { contents: [{ parts: [{ text }, { inline_data: { mime_type, data } }] }] };
    const options = {
      payload: JSON.stringify(payload),
      contentType: "application/json",
      headers: { authorization: "Bearer " + token }
    };
    const res = UrlFetchApp.fetch(url, options);
    const obj = JSON.parse(res.getContentText());
    if (obj.candidates.length > 0 && obj.candidates[0].content.parts.length > 0) {
      return obj.candidates[0].content.parts[0].text;
    }
    return "No response.";
  }


  // 1. Create corpus and document.
  const corporaList = CorporaApp.getCorpora();
  if (!corporaList.some(({ name }) => name == newCorpusName.name)) {
    // Create a new corpus.
    CorporaApp.createCorpus(newCorpusName);
  }
  const documentList = CorporaApp.getDocuments(newCorpusName.name);
  if (!documentList.some(({ name }) => name == newDocumentName.name)) {
    // Create a new document in the created corpus.
    CorporaApp.createDocument(newCorpusName.name, newDocumentName);
  }

  // 2. Retrieve description of the images using Gemini API.
  const requests = [];
  const files = DriveApp.getFolderById(folderId).searchFiles("trashed=false and mimeType contains 'image/'");
  const token = ScriptApp.getOAuthToken();
  while (files.hasNext()) {
    const file = files.next();
    const fileId = file.getId();
    const url = `https://drive.google.com/thumbnail?sz=w1000&id=${fileId}`;
    const bytes = UrlFetchApp.fetch(url, { headers: { authorization: "Bearer " + token } }).getContent();
    const base64 = Utilities.base64Encode(bytes);
    const description = getResFromImage_({ token, text: "What is this image? Explain within 50 words.", mime_type: "image/png", data: base64 });
    if (description == "No response.") continue;
    requests.push({
      parent: newDocumentName.name,
      chunk: {
        data: { stringValue: description.trim() },
        customMetadata: [{ key: "fileId", stringValue: fileId }, { key: "url", stringValue: file.getUrl() }]
      }
    });
  }
  if (requests.length == 0) return [];

  // 3. Put descriptions to document as chunks.
  return CorporaApp.setChunks(newDocumentName.name, { requests });
}
