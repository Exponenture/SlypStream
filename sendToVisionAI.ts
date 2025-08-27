import { serve } from 'https://deno.land/std@0.168.0/http/server.ts';
import { createClient } from 'https://esm.sh/@supabase/supabase-js@2';
// Environment variables - MUST be declared at top level (ONLY ONCE!)
const supabaseUrl = Deno.env.get('SUPABASE_URL');
const supabaseAnonKey = Deno.env.get('SUPABASE_ANON_KEY');
const supabaseServiceKey = Deno.env.get('SUPABASE_SERVICE_ROLE_KEY');
// Debug logging for environment variables (can remove later)
console.log('Environment variables loaded:', {
  hasUrl: !!supabaseUrl,
  hasAnonKey: !!supabaseAnonKey,
  hasServiceKey: !!supabaseServiceKey,
  urlPreview: supabaseUrl?.substring(0, 30) + '...',
  anonKeyPreview: supabaseAnonKey?.substring(0, 20) + '...',
  serviceKeyPreview: supabaseServiceKey?.substring(0, 20) + '...'
});
// CORS headers
const corsHeaders = {
  'Access-Control-Allow-Origin': '*',
  'Access-Control-Allow-Methods': 'POST, OPTIONS',
  'Access-Control-Allow-Headers': '*'
};
// Configuration
const CONFIG = {
  MAX_RETRIES: 2,
  INITIAL_DELAY: 1000,
  RETRY_DELAY_BASE: 1000,
  MAX_IMAGE_SIZE: 10 * 1024 * 1024,
  BUILDSHIP_TIMEOUT: 120000,
  STORAGE_PROPAGATION_DELAY: 5000 // 5 seconds for storage propagation
};
// Utility functions
const log = (level, message, data = null)=>{
  const timestamp = new Date().toISOString();
  const logData = data ? JSON.stringify(data, null, 2) : '';
  console[level](`[${timestamp}] ${message}${logData ? '\n' + logData : ''}`);
};
const maskUrl = (url)=>{
  if (!url || typeof url !== 'string') return 'invalid-url';
  try {
    const urlObj = new URL(url);
    return `${urlObj.protocol}//${urlObj.host}${urlObj.pathname.substring(0, 30)}...`;
  } catch  {
    return url.substring(0, 50) + '...';
  }
};
const validatePayload = (payload)=>{
  const errors = [];
  if (!payload || typeof payload !== 'object') {
    errors.push('Payload must be a valid object');
    return errors;
  }
  // Required fields
  const requiredFields = [
    'public_url',
    'filename',
    'branch',
    'date',
    'metadataId'
  ];
  for (const field of requiredFields){
    if (!payload[field]) {
      errors.push(`Missing required field: ${field}`);
    }
  }
  // Validate URL format
  if (payload.public_url) {
    try {
      new URL(payload.public_url);
      // Check if it's a Supabase storage URL
      if (!payload.public_url.includes('supabase.co') && !payload.public_url.includes('storage')) {
        errors.push('public_url must be a valid Supabase storage URL');
      }
    } catch  {
      errors.push('public_url must be a valid URL');
    }
  }
  // Validate date format
  if (payload.date && !/^\d{4}-\d{2}-\d{2}$/.test(payload.date)) {
    errors.push('date must be in YYYY-MM-DD format');
  }
  // Validate filename
  if (payload.filename && !/^[a-zA-Z0-9\-_]+\.(jpg|jpeg|png|gif|webp)$/i.test(payload.filename)) {
    errors.push('filename must be alphanumeric with valid image extension');
  }
  // Validate metadataId (UUID format)
  if (payload.metadataId && !/^[0-9a-f]{8}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{12}$/i.test(payload.metadataId)) {
    errors.push('metadataId must be a valid UUID');
  }
  return errors;
};
const fetchImageWithSupabaseClient = async (url, supabase)=>{
  log('info', `Downloading image using Supabase client: ${maskUrl(url)}`);
  // Extract path from public URL
  // URL format: https://project.supabase.co/storage/v1/object/public/bucket/path
  const urlParts = url.split('/storage/v1/object/public/');
  if (urlParts.length !== 2) {
    return {
      success: false,
      error: 'Invalid public URL format'
    };
  }
  const [bucket, ...pathParts] = urlParts[1].split('/');
  const filePath = pathParts.join('/');
  log('info', `Extracted bucket: ${bucket}, path: ${filePath}`);
  // Wait for storage propagation
  log('info', `Waiting ${CONFIG.STORAGE_PROPAGATION_DELAY}ms for storage propagation...`);
  await new Promise((resolve)=>setTimeout(resolve, CONFIG.STORAGE_PROPAGATION_DELAY));
  for(let attempt = 1; attempt <= CONFIG.MAX_RETRIES; attempt++){
    log('info', `Download attempt ${attempt}/${CONFIG.MAX_RETRIES}`);
    try {
      const { data, error } = await supabase.storage.from(bucket).download(filePath);
      if (error) {
        log('error', `Supabase storage error on attempt ${attempt}`, {
          error: error.message,
          code: error.statusCode
        });
        if (attempt < CONFIG.MAX_RETRIES) {
          const delay = CONFIG.RETRY_DELAY_BASE * attempt;
          log('info', `Retrying download in ${delay}ms...`);
          await new Promise((resolve)=>setTimeout(resolve, delay));
          continue;
        }
        return {
          success: false,
          error: `Supabase storage error: ${error.message}`,
          attempts: attempt
        };
      }
      if (!data) {
        log('error', `No data returned from Supabase storage on attempt ${attempt}`);
        if (attempt < CONFIG.MAX_RETRIES) {
          const delay = CONFIG.RETRY_DELAY_BASE * attempt;
          log('info', `Retrying download in ${delay}ms...`);
          await new Promise((resolve)=>setTimeout(resolve, delay));
          continue;
        }
        return {
          success: false,
          error: 'No data returned from storage',
          attempts: attempt
        };
      }
      // Convert blob to array buffer
      const arrayBuffer = await data.arrayBuffer();
      const imageSize = arrayBuffer.byteLength;
      log('info', 'Image downloaded successfully via Supabase client', {
        sizeBytes: imageSize,
        sizeMB: (imageSize / 1024 / 1024).toFixed(2),
        contentType: data.type || 'application/octet-stream'
      });
      // Validate image size
      if (imageSize > CONFIG.MAX_IMAGE_SIZE) {
        return {
          success: false,
          error: `Image too large: ${(imageSize / 1024 / 1024).toFixed(2)}MB (max: ${CONFIG.MAX_IMAGE_SIZE / 1024 / 1024}MB)`,
          attempts: attempt
        };
      }
      if (imageSize === 0) {
        return {
          success: false,
          error: 'Downloaded file is empty',
          attempts: attempt
        };
      }
      // Convert to base64 safely
      let base64;
      try {
        const uint8Array = new Uint8Array(arrayBuffer);
        const chunkSize = 8192;
        let binaryString = '';
        for(let i = 0; i < uint8Array.length; i += chunkSize){
          const chunk = uint8Array.slice(i, i + chunkSize);
          binaryString += String.fromCharCode.apply(null, chunk);
        }
        base64 = btoa(binaryString);
      } catch (error) {
        log('error', 'Failed to convert to base64', {
          error: error.message
        });
        return {
          success: false,
          error: `Base64 conversion failed: ${error.message}`,
          attempts: attempt
        };
      }
      log('info', 'Base64 conversion completed', {
        base64Length: base64.length,
        base64Preview: base64.substring(0, 50) + '...'
      });
      return {
        success: true,
        data: {
          arrayBuffer,
          base64,
          contentType: data.type || 'image/jpeg',
          sizeBytes: imageSize
        }
      };
    } catch (error) {
      log('error', `Download attempt ${attempt} failed`, {
        error: error.message,
        name: error.name
      });
      if (attempt === CONFIG.MAX_RETRIES) {
        return {
          success: false,
          error: error.message,
          attempts: attempt
        };
      }
      // Wait before retry
      const delay = CONFIG.RETRY_DELAY_BASE * attempt;
      log('info', `Waiting ${delay}ms before retry...`);
      await new Promise((resolve)=>setTimeout(resolve, delay));
    }
  }
  return {
    success: false,
    error: 'Maximum retries exceeded',
    attempts: CONFIG.MAX_RETRIES
  };
};
const sendToBuildShip = async (payload)=>{
  log('info', 'Preparing BuildShip payload', {
    filename: payload.filename,
    branch: payload.branch,
    date: payload.date,
    metadataId: payload.metadataId,
    imageSizeBytes: payload.imageData.sizeBytes,
    hasMetadataId: !!payload.metadataId
  });
  const buildShipPayload = {
    imageUrl: {
      type: 'external-url',
      file: payload.public_url
    },
    imageBase64: {
      type: 'base64',
      file: payload.imageData.base64,
      name: payload.filename,
      mimeType: payload.imageData.contentType
    },
    filename: payload.filename,
    branch: payload.branch,
    date: payload.date,
    slip_id: payload.metadataId,
    metadata: {
      imageSizeBytes: payload.imageData.sizeBytes,
      contentType: payload.imageData.contentType,
      uploadTimestamp: new Date().toISOString()
    }
  };
  // Add optional metadataId
  if (payload.metadataId) {
    buildShipPayload.metadataId = payload.metadataId;
  }
  log('info', 'Sending request to BuildShip...', {
    payloadSize: JSON.stringify(buildShipPayload).length,
    base64Size: payload.imageData.base64.length
  });
  for(let attempt = 1; attempt <= CONFIG.MAX_RETRIES; attempt++){
    const attemptStart = Date.now();
    try {
      const controller = new AbortController();
      const timeoutId = setTimeout(()=>{
        log('warn', `BuildShip request timeout after ${CONFIG.BUILDSHIP_TIMEOUT}ms`);
        controller.abort();
      }, CONFIG.BUILDSHIP_TIMEOUT);
      log('info', `BuildShip attempt ${attempt}/${CONFIG.MAX_RETRIES} starting...`);
      const response = await fetch('https://o6l74s.buildship.run/vision_file', {
        method: 'POST',
        headers: {
          'Content-Type': 'application/json',
          'User-Agent': 'SupabaseEdgeFunction-VisionWebhook/2.0',
          'Accept': 'application/json, text/plain, */*',
          'Accept-Language': 'en-US,en;q=0.9',
          'Connection': 'keep-alive'
        },
        body: JSON.stringify(buildShipPayload),
        signal: controller.signal
      });
      clearTimeout(timeoutId);
      const attemptDuration = Date.now() - attemptStart;
      log('info', `BuildShip response received in ${attemptDuration}ms: ${response.status} ${response.statusText}`);
      if (response.ok) {
        let responseText = '';
        try {
          responseText = await response.text();
        } catch (e) {
          responseText = 'Unable to read response body';
        }
        log('info', 'BuildShip request successful', {
          status: response.status,
          responseLength: responseText.length,
          responsePreview: responseText.substring(0, 200),
          attemptDuration
        });
        return {
          success: true,
          status: response.status,
          response: responseText,
          attempts: attempt,
          duration: attemptDuration
        };
      } else {
        let errorText = 'Unable to read error response';
        try {
          errorText = await response.text();
        } catch (e) {
          log('info', 'Could not read BuildShip error response');
        }
        log('error', `BuildShip error ${response.status}`, {
          errorText: errorText.substring(0, 500),
          attemptDuration
        });
        // Don't retry on client errors (4xx) except 429 (rate limit)
        if (response.status >= 400 && response.status < 500 && response.status !== 429) {
          return {
            success: false,
            status: response.status,
            error: `BuildShip client error: ${response.status} ${response.statusText}`,
            details: errorText,
            attempts: attempt,
            duration: attemptDuration
          };
        }
        if (attempt < CONFIG.MAX_RETRIES) {
          const delay = CONFIG.RETRY_DELAY_BASE * attempt;
          log('info', `Retrying BuildShip request in ${delay}ms...`);
          await new Promise((resolve)=>setTimeout(resolve, delay));
          continue;
        }
        return {
          success: false,
          status: response.status,
          error: `BuildShip error: ${response.status} ${response.statusText}`,
          details: errorText,
          attempts: attempt,
          duration: attemptDuration
        };
      }
    } catch (error) {
      const attemptDuration = Date.now() - attemptStart;
      log('error', `BuildShip attempt ${attempt} failed`, {
        error: error.message,
        name: error.name,
        attemptDuration
      });
      // Check if it's a timeout/abort error
      if (error.name === 'AbortError' || error.message.includes('aborted')) {
        log('error', `BuildShip request aborted/timed out after ${attemptDuration}ms`);
        if (attempt < CONFIG.MAX_RETRIES) {
          log('info', `Retrying BuildShip request in ${CONFIG.RETRY_DELAY_BASE}ms...`);
          await new Promise((resolve)=>setTimeout(resolve, CONFIG.RETRY_DELAY_BASE));
          continue;
        }
        return {
          success: false,
          error: `BuildShip timeout after ${CONFIG.BUILDSHIP_TIMEOUT}ms`,
          attempts: attempt,
          duration: attemptDuration
        };
      }
      if (attempt === CONFIG.MAX_RETRIES) {
        return {
          success: false,
          error: `BuildShip request failed: ${error.message}`,
          attempts: attempt,
          duration: attemptDuration
        };
      }
      const delay = CONFIG.RETRY_DELAY_BASE * attempt;
      log('info', `Retrying BuildShip request in ${delay}ms...`);
      await new Promise((resolve)=>setTimeout(resolve, delay));
    }
  }
  return {
    success: false,
    error: 'All BuildShip attempts failed',
    attempts: CONFIG.MAX_RETRIES
  };
};
// Main serve function
serve(async (req)=>{
  const requestId = crypto.randomUUID().substring(0, 8);
  const startTime = Date.now();
  log('info', `[${requestId}] Request received: ${req.method} ${req.url}`);
  // Handle CORS preflight
  if (req.method === 'OPTIONS') {
    return new Response(null, {
      status: 200,
      headers: corsHeaders
    });
  }
  // Only allow POST requests
  if (req.method !== 'POST') {
    log('error', `[${requestId}] Method ${req.method} not allowed`);
    return new Response(JSON.stringify({
      error: 'Method not allowed',
      requestId
    }), {
      status: 405,
      headers: {
        ...corsHeaders,
        'Content-Type': 'application/json'
      }
    });
  }
  try {
    // Validate environment variables at request time
    if (!supabaseUrl || !supabaseAnonKey || !supabaseServiceKey) {
      log('error', `[${requestId}] Missing environment variables`, {
        hasUrl: !!supabaseUrl,
        hasAnonKey: !!supabaseAnonKey,
        hasServiceKey: !!supabaseServiceKey
      });
      return new Response(JSON.stringify({
        error: 'Server configuration error',
        details: 'Missing required environment variables',
        requestId
      }), {
        status: 500,
        headers: {
          ...corsHeaders,
          'Content-Type': 'application/json'
        }
      });
    }
    // Parse payload
    let payload;
    try {
      const rawBody = await req.text();
      log('info', `[${requestId}] Raw request body received`, {
        bodyLength: rawBody.length,
        bodyPreview: rawBody.substring(0, 200)
      });
      payload = JSON.parse(rawBody);
    } catch (error) {
      log('error', `[${requestId}] Invalid JSON payload`, {
        error: error.message
      });
      return new Response(JSON.stringify({
        error: 'Invalid JSON payload',
        details: error.message,
        requestId
      }), {
        status: 400,
        headers: {
          ...corsHeaders,
          'Content-Type': 'application/json'
        }
      });
    }
    // Validate payload
    const validationErrors = validatePayload(payload);
    if (validationErrors.length > 0) {
      log('error', `[${requestId}] Validation failed`, {
        errors: validationErrors
      });
      return new Response(JSON.stringify({
        error: 'Validation failed',
        details: validationErrors,
        requestId
      }), {
        status: 400,
        headers: {
          ...corsHeaders,
          'Content-Type': 'application/json'
        }
      });
    }
    log('info', `[${requestId}] Processing webhook for file: ${payload.filename}`, {
      branch: payload.branch,
      date: payload.date,
      metadataId: payload.metadataId,
      url: maskUrl(payload.public_url),
      hasMetadataId: !!payload.metadataId
    });
    // Initialize Supabase client
    const supabase = createClient(supabaseUrl, supabaseAnonKey, {
      global: {
        headers: {
          Authorization: `Bearer ${supabaseServiceKey}`
        }
      }
    });
    // Fetch image using Supabase client (more reliable than HTTP fetch)
    const fetchResult = await fetchImageWithSupabaseClient(payload.public_url, supabase);
    if (!fetchResult.success) {
      log('error', `[${requestId}] Failed to fetch image`, {
        error: fetchResult.error,
        attempts: fetchResult.attempts
      });
      return new Response(JSON.stringify({
        error: 'Failed to fetch image from storage',
        details: fetchResult.error,
        url: maskUrl(payload.public_url),
        requestId
      }), {
        status: 500,
        headers: {
          ...corsHeaders,
          'Content-Type': 'application/json'
        }
      });
    }
    // Send to BuildShip
    const buildShipResult = await sendToBuildShip({
      ...payload,
      imageData: fetchResult.data
    });
    const processingTime = Date.now() - startTime;
    if (!buildShipResult.success) {
      log('error', `[${requestId}] BuildShip request failed`, {
        error: buildShipResult.error,
        attempts: buildShipResult.attempts,
        processingTimeMs: processingTime
      });
      return new Response(JSON.stringify({
        error: 'Failed to send to BuildShip',
        details: buildShipResult.error,
        attempts: buildShipResult.attempts,
        requestId,
        processingTimeMs: processingTime
      }), {
        status: 500,
        headers: {
          ...corsHeaders,
          'Content-Type': 'application/json'
        }
      });
    }
    // Success response
    log('info', `[${requestId}] Webhook processing completed successfully`, {
      processingTimeMs: processingTime,
      buildShipStatus: buildShipResult.status,
      buildShipAttempts: buildShipResult.attempts,
      imageSizeBytes: fetchResult.data.sizeBytes
    });
    return new Response(JSON.stringify({
      success: true,
      message: 'Webhook processed successfully',
      data: {
        requestId,
        processingTimeMs: processingTime,
        buildShipStatus: buildShipResult.status,
        buildShipResponse: buildShipResult.response,
        buildShipAttempts: buildShipResult.attempts,
        imageMetadata: {
          filename: payload.filename,
          sizeBytes: fetchResult.data.sizeBytes,
          contentType: fetchResult.data.contentType
        }
      }
    }), {
      status: 200,
      headers: {
        ...corsHeaders,
        'Content-Type': 'application/json'
      }
    });
  } catch (error) {
    const processingTime = Date.now() - startTime;
    log('error', `[${requestId}] Unexpected error`, {
      error: error.message,
      stack: error.stack?.substring(0, 500),
      processingTimeMs: processingTime
    });
    return new Response(JSON.stringify({
      error: 'Internal server error',
      details: error.message,
      requestId,
      processingTimeMs: processingTime
    }), {
      status: 500,
      headers: {
        ...corsHeaders,
        'Content-Type': 'application/json'
      }
    });
  }
});
