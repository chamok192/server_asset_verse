function buildAssetDocument(assetData) {
  const now = new Date();

  return {
    productName: assetData.productName || '',
    productImage: assetData.productImage || '',
    productType: assetData.productType || 'Returnable',
    productQuantity: Number(assetData.productQuantity) || 0,
    availableQuantity: (Number(assetData.availableQuantity) ?? Number(assetData.productQuantity)) || 0,
    dateAdded: assetData.dateAdded || now,
    hrEmail: assetData.hrEmail || '',
    companyName: assetData.companyName || '',
    createdAt: assetData.createdAt || now,
    updatedAt: now
  };
}

function validateAsset(assetData) {
  const errors = [];

  if (!assetData.productName || !assetData.productName.trim()) errors.push('Product Name is required');
  if (!assetData.productType) errors.push('Product Type is required');
  if (assetData.productQuantity === undefined || assetData.productQuantity === null) errors.push('Product Quantity is required');

  const validTypes = ['Returnable', 'Non-returnable'];
  if (assetData.productType && !validTypes.includes(assetData.productType)) {
    errors.push(`Type must be one of: ${validTypes.join(', ')}`);
  }

  return { valid: errors.length === 0, errors };
}

module.exports = { buildAssetDocument, validateAsset };
