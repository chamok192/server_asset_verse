function buildAssetDocument(assetData) {
  const now = new Date();
  
  return {
    name: assetData.name || '',
    image: assetData.image || '',
    type: assetData.type || 'returnable',
    quantity: Number(assetData.quantity) || 0,
    createdAt: assetData.createdAt || now,
    updatedAt: now
  };
}

function validateAsset(assetData) {
  const errors = [];
  
  if (!assetData.name || !assetData.name.trim()) errors.push('Name is required');
  if (!assetData.type) errors.push('Type is required');
  if (assetData.quantity === undefined || assetData.quantity === null) errors.push('Quantity is required');
  
  const validTypes = ['returnable', 'non-returnable'];
  if (assetData.type && !validTypes.includes(assetData.type)) {
    errors.push(`Type must be one of: ${validTypes.join(', ')}`);
  }
  
  return { valid: errors.length === 0, errors };
}

module.exports = { buildAssetDocument, validateAsset };
