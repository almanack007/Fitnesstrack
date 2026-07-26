const env = require('../config/env');

const GEMINI_ENDPOINT = `https://generativelanguage.googleapis.com/v1beta/models/gemini-3.5-flash:generateContent?key=${env.GEMINI_API_KEY}`;
const geminiEnabled = !!env.GEMINI_API_KEY;

exports.testGemini = async (req, res) => {
  const models = ['gemini-3.5-flash', 'gemini-1.5-flash', 'gemini-2.0-flash', 'gemini-1.5-flash-8b', 'gemini-1.5-pro'];
  const versions = ['v1beta', 'v1'];
  const results = [];

  for (const version of versions) {
    for (const model of models) {
      const url = `https://generativelanguage.googleapis.com/${version}/models/${model}:generateContent?key=${env.GEMINI_API_KEY}`;
      try {
        const testRes = await fetch(url, {
          method: 'POST',
          headers: { 'Content-Type': 'application/json' },
          body: JSON.stringify({
            contents: [{ parts: [{ text: 'Respond with the word: OK' }] }]
          })
        });
        const text = await testRes.text();
        results.push({
          version,
          model,
          status: testRes.status,
          response: text.substring(0, 300)
        });
      } catch (err) {
        results.push({
          version,
          model,
          error: err.message
        });
      }
    }
  }

  res.json({
    keyHint: env.GEMINI_API_KEY ? env.GEMINI_API_KEY.substring(0, 6) + '...' : 'NOT SET',
    results
  });
};

exports.scanFood = async (req, res) => {
  const { image } = req.body;

  console.log(`[LensPro /api/scan] Request received. Image present: ${!!image}, length: ${image ? image.length : 0} chars`);

  if (!image) {
    return res.status(400).json({ error: 'Image data is required' });
  }

  if (!geminiEnabled) {
    console.log('[LensPro /api/scan] No API key — returning scanner_unavailable.');
    return res.json({ scanner_unavailable: true, message: 'Gemini API key not configured on server.' });
  }

  try {
    const imgMatch = image.match(/^data:image\/([a-zA-Z0-9]+);base64,(.+)$/);
    if (!imgMatch) {
      return res.status(400).json({ error: 'Invalid base64 image format' });
    }
    const mimeType = `image/${imgMatch[1]}`;
    const base64Data = imgMatch[2];

    console.log(`[LensPro /api/scan] Image OK — mime: ${mimeType}, size: ~${Math.round(base64Data.length * 0.75 / 1024)}KB`);

    const prompt = `You are a world-class food recognition AI with the same visual accuracy as Google Lens.
Analyze this image carefully and thoroughly.

IDENTIFY: Identify the food name as specifically and accurately as possible using your complete visual and internet knowledge (colors, textures, ingredients, cooking style, plating context).
Examples of good answers: "white basmati rice", "banana", "butter chicken curry", "scrambled eggs", "aloo paratha", "masala dosa".

DECIDE: Is there actual VISIBLE, OPEN food in the image?
Rules:
- If you can clearly see food (even if it is being held in someone's hand), set is_food to true
- Sealed/closed container, jar, tin, bottle, or wrapped packet where food is NOT visible = NOT FOOD
- Non-food object with NO food visible at all (electronics, furniture, fabric, floor, wall, screen, paper) = NOT FOOD
- Blurry, dark, or completely unidentifiable content with no food visible = NOT FOOD
- A hand or person holding food (e.g. holding a lemon, mango, apple) = FOOD — focus on the food item, not the hand
- Clearly visible prepared, raw, plated, or held food = FOOD

MATCH: If FOOD, check if it matches any item in our database of tracked foods:
["Daal Chawal","Paneer Butter Masala","Butter Chicken","Chana Masala","Chicken Biryani","Veg Biryani","Choole Bhature","Dal Makhani","Palak Paneer","Rajma Chawal","Khichdi","Muttar Paneer","Aloo Gobi","Bhindi Masala","Basmati Rice Cooked","Brown Rice Cooked","Roti / Chapati","Tandoori Roti","Plain Paratha","Aloo Paratha","Butter Naan","Garlic Naan","Puri","Bhatura","Poha","Upma","Idli with Sambar","Masala Dosa","Moong Dal Cooked","Masoor Dal Cooked","Soya Chunks Cooked","Paneer Bhurji","Tandoori Chicken","Fish Tikka","Chicken Tikka","Egg Bhurji","Boiled Egg","Chicken Breast","Mutton Curry","Paneer raw","Whole Milk Curd / Dahi","Cow Milk","Buffalo Milk","Ghee","Sweet Lassi","Chaas / Buttermilk","Samosa","Dhokla","Medu Vada","Pani Puri","Bhel Puri","Pav Bhaji","Vada Pav","Roasted Chana","Roasted Makhana","Gulab Jamun","Rasgulla","Gajar ka Halwa","Jalebi","Besan Ladoo","Kheer","Masala Chai","Filter Coffee","Tender Coconut Water","Sugarcane Juice","Nimbu Pani","Banana","Apple","Mango","Orange","Papaya"]

If it is a close visual match, set "match" to the exact string from the list above. If it does not match any item closely, set "match" to "" (empty string) and we will use the estimated macros.

MACROS: If FOOD, estimate the macronutrient profile per 100g (or per piece/cup if more natural for fruits/eggs/beverages) based on standard USDA/nutritional databases.
Fields in estimated_macros:
- cal: calories (kcal)
- protein: protein in grams
- carbs: total carbohydrates in grams
- fat: fat in grams
- unit: serving unit, either "g" (default), "cup" (for beverages/liquids), or "piece" (for fruits, boiled eggs, etc.)
- per: serving size value (100 for "g", 1 for "piece" or "cup")

CONFIDENCE: Provide two separate confidence scores from 0 to 100:
- food_confidence: How confident you are that the image contains a visible, open, and identifiable food item. (This should be very high, e.g., 95-100, for clear images of food like a green mango or chicken curry, regardless of whether it matches our database list).
- match_confidence: How confident you are that the food item matches the specific database item you selected. If "match" is empty, this should be 0.

REJECTION MESSAGE: If NOT FOOD, write one short friendly sentence saying what you actually see (e.g. "Looks like a laptop screen — point the camera at your meal instead.").

IMPORTANT: Output NOTHING except the raw JSON. DO NOT output your reasoning or thoughts. DO NOT use markdown code blocks. Just the raw JSON object:
{
  "is_food": true or false,
  "identified_as": "specific food name if food, otherwise empty string",
  "match": "exact name from database list if matched, otherwise empty string",
  "food_confidence": 0-100,
  "match_confidence": 0-100,
  "rejection_message": "friendly message if not food, otherwise empty string",
  "estimated_macros": {
    "cal": 0,
    "protein": 0.0,
    "carbs": 0.0,
    "fat": 0.0,
    "unit": "g",
    "per": 100
  }
}`;

    const body = {
      systemInstruction: {
        parts: [{ text: "You are an automated backend API. You must ONLY output a single, raw JSON object. Never include any reasoning, markdown formatting, explanations, or step-by-step text." }]
      },
      contents: [{
        parts: [
          { text: prompt },
          { inlineData: { mimeType: mimeType, data: base64Data } }
        ]
      }],
      safetySettings: [
        { category: "HARM_CATEGORY_HARASSMENT", threshold: "BLOCK_NONE" },
        { category: "HARM_CATEGORY_HATE_SPEECH", threshold: "BLOCK_NONE" },
        { category: "HARM_CATEGORY_SEXUALLY_EXPLICIT", threshold: "BLOCK_NONE" },
        { category: "HARM_CATEGORY_DANGEROUS_CONTENT", threshold: "BLOCK_NONE" }
      ],
      generationConfig: {
        temperature: 0.1,
        maxOutputTokens: 2048,
        responseMimeType: "application/json",
        responseSchema: {
          type: "OBJECT",
          properties: {
            is_food: { type: "BOOLEAN" },
            identified_as: { type: "STRING" },
            match: { type: "STRING" },
            food_confidence: { type: "INTEGER" },
            match_confidence: { type: "INTEGER" },
            rejection_message: { type: "STRING" },
            estimated_macros: {
              type: "OBJECT",
              properties: {
                cal: { type: "INTEGER" },
                protein: { type: "NUMBER" },
                carbs: { type: "NUMBER" },
                fat: { type: "NUMBER" },
                unit: { type: "STRING" },
                per: { type: "INTEGER" }
              },
              required: ["cal", "protein", "carbs", "fat", "unit", "per"]
            }
          },
          required: ["is_food", "identified_as", "match", "food_confidence", "match_confidence", "rejection_message", "estimated_macros"]
        }
      }
    };

    console.log('[LensPro /api/scan] Calling Gemini REST API via fetch...');
    const startTime = Date.now();

    const geminiRes = await fetch(GEMINI_ENDPOINT, {
      method: 'POST',
      headers: { 'Content-Type': 'application/json' },
      body: JSON.stringify(body)
    });

    const elapsed = Date.now() - startTime;
    console.log(`[LensPro /api/scan] Gemini responded in ${elapsed}ms. HTTP status: ${geminiRes.status}`);

    if (!geminiRes.ok) {
      const errText = await geminiRes.text();
      console.error('[LensPro /api/scan] Gemini API error response:', errText);
      return res.status(502).json({ error: 'Gemini API returned an error', detail: errText.substring(0, 200) });
    }

    const geminiJson = await geminiRes.json();
    const finishReason = geminiJson?.candidates?.[0]?.finishReason || 'UNKNOWN';
    let text = geminiJson?.candidates?.[0]?.content?.parts?.[0]?.text || '';
    console.log(`[LensPro /api/scan] Raw Gemini text (finishReason: ${finishReason}): "${text}"`);

    // Clean any accidental markdown
    text = text.replace(/```json\s*/gi, '').replace(/```\s*/g, '').trim();

    let parsed;
    try {
      parsed = JSON.parse(text);
      if (parsed.food_confidence !== undefined) {
        parsed.confidence = parseInt(parsed.food_confidence, 10);
      } else if (parsed.confidence !== undefined) {
        parsed.confidence = parseInt(parsed.confidence, 10);
      } else {
        parsed.confidence = 95;
      }
    } catch (e) {
      console.error('[LensPro /api/scan] JSON parse failed, using regex extraction. Text was:', text);
      const isFoodMatch = /"is_food"\s*:\s*true/i.test(text);
      const identMatch = text.match(/"identified_as"\s*:\s*"([^"]*)"/); 
      const matchMatch = text.match(/"match"\s*:\s*"([^"]*)"/); 
      
      const foodConfMatch = text.match(/"food_confidence"\s*:\s*(\d+)/);
      const oldConfMatch = text.match(/"confidence"\s*:\s*(\d+)/);
      const confVal = foodConfMatch ? parseInt(foodConfMatch[1], 10) : (oldConfMatch ? parseInt(oldConfMatch[1], 10) : 95);
      
      const rejMatch = text.match(/"rejection_message"\s*:\s*"([^"]*)"/); 
      
      const calMatch = text.match(/"cal"\s*:\s*(\d+)/);
      const protMatch = text.match(/"protein"\s*:\s*([\d.]+)/);
      const carbMatch = text.match(/"carbs"\s*:\s*([\d.]+)/);
      const fatMatch = text.match(/"fat"\s*:\s*([\d.]+)/);
      const unitMatch = text.match(/"unit"\s*:\s*"([^"]*)"/);
      const perMatch = text.match(/"per"\s*:\s*(\d+)/);
      
      parsed = {
        is_food: isFoodMatch,
        identified_as: identMatch ? identMatch[1] : '',
        match: matchMatch ? matchMatch[1] : '',
        confidence: confVal,
        rejection_message: rejMatch ? rejMatch[1] : '',
        estimated_macros: isFoodMatch ? {
          cal: calMatch ? parseInt(calMatch[1], 10) : 0,
          protein: protMatch ? parseFloat(protMatch[1]) : 0,
          carbs: carbMatch ? parseFloat(carbMatch[1]) : 0,
          fat: fatMatch ? parseFloat(fatMatch[1]) : 0,
          unit: unitMatch ? unitMatch[1] : 'g',
          per: perMatch ? parseInt(perMatch[1], 10) : 100
        } : null
      };
    }

    // Confidence gate: < 70 → treat as not_food
    if (parsed.is_food && parsed.confidence < 70) {
      console.log(`[LensPro /api/scan] Confidence ${parsed.confidence} < 70 — downgrading to not_food`);
      parsed.is_food = false;
      parsed.rejection_message = `I can see something but I'm only ${parsed.confidence}% sure it's "${parsed.identified_as || 'food'}". Try a clearer, closer photo with better lighting.`;
      parsed.identified_as = '';
      parsed.match = '';
      parsed.estimated_macros = null;
    }

    console.log(`[LensPro /api/scan] RESULT: is_food=${parsed.is_food}, identified_as="${parsed.identified_as}", match="${parsed.match}", confidence=${parsed.confidence}`);
    res.json(parsed);

  } catch (error) {
    console.error('[LensPro /api/scan] FATAL ERROR:', error.message);
    res.status(500).json({ error: 'AI visual scanning failed', detail: error.message });
  }
};

exports.chatCoach = async (req, res) => {
  if (!geminiEnabled) {
    return res.json({ error: 'Gemini API key not configured on server.', assistant_unavailable: true });
  }
  const { messages = [], context = {} } = req.body;
  
  const systemPrompt = `You are the AI Fitness Coach for FitTrack, a premium Indian consumer fitness application.
Your goal is to provide highly contextual, encouraging, and accurate nutrition, hydration, and exercise advice.
Understand Indian diet items (e.g. Roti, Paneer, Dal, Chicken Tikka, Idli, Dosa) and portions.
Current User Context:
- Active Screen/Tab: ${context.activeTab || 'Home'}
- Profile: ${context.userProfile ? JSON.stringify(context.userProfile) : 'None'}
- Today's Meals logged: ${context.todayLog ? JSON.stringify(context.todayLog) : '[]'}
- Today's Water: ${context.waterIntake || 0} mL
- Today's Totals: ${context.totals ? JSON.stringify(context.totals) : '{}'}
- Today's Burned Calories: ${context.burnedCal || 0} kcal

Respond naturally like a real friendly personal trainer. Give complete, helpful answers. Keep them structured and easy to read.`;

  const contents = messages.map(m => ({
    role: m.role === 'user' ? 'user' : 'model',
    parts: [{ text: m.content }]
  }));

  const requestBody = {
    systemInstruction: {
      parts: [{ text: systemPrompt }]
    },
    contents: contents,
    generationConfig: {
      temperature: 0.7,
      maxOutputTokens: 2048
    }
  };

  try {
    const geminiRes = await fetch(GEMINI_ENDPOINT, {
      method: 'POST',
      headers: { 'Content-Type': 'application/json' },
      body: JSON.stringify(requestBody)
    });

    if (!geminiRes.ok) {
      const errText = await geminiRes.text();
      return res.status(502).json({ error: 'Gemini API failed', detail: errText });
    }

    const json = await geminiRes.json();
    const reply = json?.candidates?.[0]?.content?.parts?.[0]?.text || 'No response generated.';
    res.json({ reply });
  } catch (err) {
    res.status(500).json({ error: 'Failed to connect to AI server', detail: err.message });
  }
};

