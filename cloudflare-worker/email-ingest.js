export default {
  async email(message, env, ctx) {
    const rawEmail = await new Response(message.raw).text();
    
    const ingestUrl = env.OPENENVELOPE_INGEST_URL;
    const apiKey = env.INGEST_API_KEY;
    
    if (!ingestUrl) {
      console.error('OPENENVELOPE_INGEST_URL not configured');
      return;
    }

    if (!apiKey) {
      console.error('INGEST_API_KEY not configured');
      return;
    }

    try {
      const response = await fetch(`${ingestUrl}/api/ingest/email`, {
        method: 'POST',
        headers: {
          'Content-Type': 'message/rfc822',
          'X-API-Key': apiKey,
        },
        body: rawEmail,
      });

      if (!response.ok) {
        const text = await response.text();
        console.error('Failed to ingest email:', response.status, text);
      } else {
        console.log('Email ingested successfully');
      }
    } catch (error) {
      console.error('Error forwarding email:', error);
    }
  },
};
